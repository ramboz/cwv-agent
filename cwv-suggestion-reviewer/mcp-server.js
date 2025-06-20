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
        throw new Error(`SpaceCat API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error) {
      throw new Error(`SpaceCat API request failed: ${error.message}`);
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
      const sites = await this.apiRequest('/sites');
      
      // Find site by normalized base URL
      const site = sites.find(site => site.baseURL === normalizedUrl);
      
      if (!site) {
        // For debugging, let's also check what sites are available
        const availableSites = sites.map(s => s.baseURL).join(', ');
        throw new Error(`Site not found. Looking for: "${normalizedUrl}". Available sites: ${availableSites}`);
      }
      
      return site;
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
   * Create or get CWV opportunity
   */
  async ensureCWVOpportunity(siteId) {
    try {
      const opportunities = await this.getSiteOpportunities(siteId);
      let cwvOpportunity = opportunities.find(opp => opp.type === 'cwv');
      
      if (!cwvOpportunity) {
        // Create new CWV opportunity
        cwvOpportunity = await this.apiRequest(`/sites/${siteId}/opportunities`, {
          method: 'POST',
          body: JSON.stringify({
            type: 'cwv',
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
   * Create suggestion for opportunity
   */
  async createSuggestion(siteId, opportunityId, suggestion, url) {
    try {
      // Generate a unique ID for the suggestion
      const suggestionId = `cwv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Format the payload to match SpaceCat's expected structure (based on your example)
      const suggestionData = {
        id: suggestionId,
        type: "CODE_CHANGE",
        rank: 0,
        status: "NEW",
        data: {
          url: url || "",
          metrics: [
            {
              deviceType: "mobile",
              pageviews: 0,
              lcp: 0,
              lcpCount: 0,
              cls: 0,
              clsCount: 0,
              inp: 0,
              inpCount: 0,
              ttfb: 0,
              ttfbCount: 0
            },
            {
              deviceType: "desktop", 
              pageviews: 0,
              lcp: 0,
              lcpCount: 0,
              cls: 0,
              clsCount: 0,
              inp: 0,
              inpCount: 0,
              ttfb: 0,
              ttfbCount: 0
            }
          ],
          type: "url",
          issues: [
            {
              type: suggestion.metric.toLowerCase(),
              value: `# ${suggestion.title}\n\n${suggestion.description}\n\n## Implementation\n\n${suggestion.implementation}\n\n## Code Example\n\n\`\`\`${suggestion.category || 'javascript'}\n${suggestion.codeExample}\n\`\`\``
            }
          ]
        }
      };

      // SpaceCat API expects an array of suggestions
      const payload = [suggestionData];

      // Use the correct SpaceCat API endpoint
      const endpoint = `/sites/${siteId}/opportunities/${opportunityId}/suggestions`;
      
      return await this.apiRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    } catch (error) {
      throw new Error(`Failed to create suggestion: ${error.message}`);
    }
  }
}

/**
 * MCP Tools Server for CWV Suggestion Management
 * Implements proper MCP protocol for Cursor.io integration
 */

class CWVSuggestionManager {
  constructor() {
    this.suggestions = [];
    this.currentFile = null;
    this.currentUrl = null;
    this.tempDir = path.join(__dirname, 'temp-edits');
    this.approvedSuggestions = [];
    this.editedSuggestions = new Map();
    this.spaceCatClient = new SpaceCatClient();
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Load suggestions from a JSON file
   */
  loadSuggestions(filePath) {
    try {
      // Try multiple path resolution strategies
      const projectRoot = path.resolve(__dirname, '..');
      const possiblePaths = [];
      
      // If it's already an absolute path, use it as-is
      if (path.isAbsolute(filePath)) {
        possiblePaths.push(filePath);
      } else {
        // For relative paths, try different base directories
        possiblePaths.push(
          path.resolve(projectRoot, filePath), // Resolve from project root - this should work!
          path.resolve(__dirname, filePath), // Resolve from current MCP server directory
          path.resolve(projectRoot, '..', filePath), // Resolve from grandparent directory
        );
      }

      let fullPath = null;
      let content = null;

      // Try each possible path until we find the file
      for (const tryPath of possiblePaths) {
        try {
          if (fs.existsSync(tryPath)) {
            fullPath = tryPath;
            content = fs.readFileSync(tryPath, 'utf8');
            break;
          }
        } catch (err) {
          // Continue to next path
          continue;
        }
      }

      if (!content) {
        const pathsStr = possiblePaths.map((p, i) => `  ${i + 1}. ${p} ${fs.existsSync(p) ? '✓ exists' : '✗ not found'}`).join('\n');
        throw new Error(`File not found. Tried these paths:\n${pathsStr}\n\nTip: Use relative paths like '.cache/filename.json' or '../cache/filename.json'`);
      }

      const data = JSON.parse(content);
      
      if (!data.suggestions || !Array.isArray(data.suggestions)) {
        throw new Error('Invalid suggestions file format');
      }
      
      this.suggestions = data.suggestions;
      this.currentFile = fullPath;
      this.currentUrl = data.url;
      
      return {
        success: true,
        url: data.url,
        deviceType: data.deviceType,
        totalSuggestions: data.suggestions.length,
        summary: this.generateSummary(),
        suggestions: data.suggestions
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate a summary of suggestions by priority
   */
  generateSummary() {
    const byPriority = {
      High: [],
      Medium: [],
      Low: []
    };
    
    this.suggestions.forEach((suggestion, index) => {
      const priority = suggestion.priority || 'Medium';
      byPriority[priority].push({
        index: index + 1,
        title: suggestion.title,
        metric: suggestion.metric,
        impact: suggestion.impact,
        effort: suggestion.effort
      });
    });
    
    return byPriority;
  }

  /**
   * Create a temporary markdown file for editing a suggestion
   */
  createSuggestionEditor(suggestionIndex) {
    try {
      const index = parseInt(suggestionIndex) - 1;
      if (index < 0 || index >= this.suggestions.length) {
        throw new Error(`Invalid suggestion index: ${suggestionIndex}`);
      }
      
      const suggestion = this.suggestions[index];
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `suggestion-${suggestionIndex}-${timestamp}.md`;
      const filePath = path.join(this.tempDir, filename);
      
      const markdown = this.generateSuggestionMarkdown(suggestion, suggestionIndex);
      fs.writeFileSync(filePath, markdown);
      
      return {
        success: true,
        filePath,
        filename,
        message: `Created editor for suggestion ${suggestionIndex}. Edit the file and save when ready.`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate markdown content for editing a suggestion
   */
  generateSuggestionMarkdown(suggestion, index) {
    return `# Edit Suggestion ${index}

<!-- DO NOT MODIFY THIS HEADER -->
<!-- SUGGESTION_ID: ${index} -->
<!-- ORIGINAL_METRIC: ${suggestion.metric} -->
<!-- ORIGINAL_CATEGORY: ${suggestion.category} -->

## Title
${suggestion.title}

## Description
${suggestion.description}

## Priority
<!-- Options: High, Medium, Low -->
${suggestion.priority}

## Effort  
<!-- Options: Easy, Medium, Hard -->
${suggestion.effort}

## Expected Impact
${suggestion.impact}

## Implementation Details
${suggestion.implementation || ''}

## Code Example
\`\`\`
${suggestion.codeExample || ''}
\`\`\`

## Notes
<!-- Add any additional notes or modifications here -->

---
**Instructions:**
- Edit any section above as needed
- Do not modify the header comments (they contain metadata)
- Save the file when you're done editing
- The AI will automatically detect and process your changes
`;
  }

  /**
   * Read back the edited suggestion from markdown file
   */
  readSuggestionEdits(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      
      const content = fs.readFileSync(filePath, 'utf8');
      const suggestion = this.parseSuggestionMarkdown(content);
      
      // Store the edited suggestion
      this.editedSuggestions.set(suggestion.id, suggestion);
      
      return {
        success: true,
        suggestion,
        message: `Successfully processed edits for suggestion ${suggestion.id}`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Parse markdown content back into suggestion object
   */
  parseSuggestionMarkdown(content) {
    const lines = content.split('\n');
    
    // Extract metadata from header
    const suggestionId = this.extractMetadata(content, 'SUGGESTION_ID');
    const originalMetric = this.extractMetadata(content, 'ORIGINAL_METRIC');
    const originalCategory = this.extractMetadata(content, 'ORIGINAL_CATEGORY');
    
    // Extract sections
    const title = this.extractSection(content, '## Title', '## Description').trim();
    const description = this.extractSection(content, '## Description', '## Priority').trim();
    const priority = this.extractSection(content, '## Priority', '## Effort').replace(/<!-- .* -->/g, '').trim();
    const effort = this.extractSection(content, '## Effort', '## Expected Impact').replace(/<!-- .* -->/g, '').trim();
    const impact = this.extractSection(content, '## Expected Impact', '## Implementation Details').trim();
    const implementation = this.extractSection(content, '## Implementation Details', '## Code Example').trim();
    const codeExample = this.extractCodeBlock(content);
    const notes = this.extractSection(content, '## Notes', '---').replace(/<!-- .* -->/g, '').trim();
    
    return {
      id: parseInt(suggestionId),
      title,
      description,
      metric: originalMetric,
      priority,
      effort,
      impact,
      implementation,
      codeExample,
      category: originalCategory,
      notes,
      edited: true,
      editedAt: new Date().toISOString()
    };
  }

  extractMetadata(content, key) {
    const match = content.match(new RegExp(`<!-- ${key}: (.+) -->`));
    return match ? match[1] : null;
  }

  extractSection(content, startMarker, endMarker) {
    const startIndex = content.indexOf(startMarker);
    const endIndex = content.indexOf(endMarker, startIndex + startMarker.length);
    
    if (startIndex === -1) return '';
    
    const start = startIndex + startMarker.length;
    const end = endIndex === -1 ? content.length : endIndex;
    
    return content.slice(start, end).trim();
  }

  extractCodeBlock(content) {
    const match = content.match(/```\n([\s\S]*?)\n```/);
    return match ? match[1].trim() : '';
  }

  /**
   * Upload suggestion to SpaceCat
   */
  async uploadToSpaceCat(suggestionId, dryRun = false) {
    try {
      const index = parseInt(suggestionId) - 1;
      let suggestion = this.suggestions[index];
      
      // Use edited version if available
      if (this.editedSuggestions.has(parseInt(suggestionId))) {
        suggestion = this.editedSuggestions.get(parseInt(suggestionId));
      }
      
      if (!suggestion) {
        throw new Error(`Suggestion ${suggestionId} not found`);
      }
      
      // Extract the base URL from the current loaded file
      if (!this.currentUrl) {
        // Try to extract from loaded suggestions file
        const data = JSON.parse(fs.readFileSync(this.currentFile, 'utf8'));
        this.currentUrl = data.url;
      }

      if (!this.currentUrl) {
        throw new Error('No URL found for current suggestions. Unable to identify target site.');
      }

      // Real SpaceCat API integration - perform lookups even in dry run
      try {
        // 1. Get the site by URL
        const site = await this.spaceCatClient.getSiteByBaseUrl(this.currentUrl);
        if (!site) {
          throw new Error(`Site not found in SpaceCat for URL: ${this.currentUrl}`);
        }

        // 2. Ensure CWV opportunity exists
        const opportunity = await this.spaceCatClient.ensureCWVOpportunity(site.id);

        // 3. Handle dry run vs real upload
        if (dryRun) {
          return {
            success: true,
            dryRun: true,
            suggestion,
            site: {
              id: site.id,
              baseURL: site.baseURL
            },
            opportunityId: opportunity.id,
            message: `[DRY RUN] Would upload suggestion ${suggestionId} to SpaceCat for ${site.baseURL} (Site ID: ${site.id}, Opportunity ID: ${opportunity.id})`
          };
        }

        // 4. Create the suggestion (real upload)
        const result = await this.spaceCatClient.createSuggestion(site.id, opportunity.id, suggestion, this.currentUrl);

        // Track the approved suggestion
        this.approvedSuggestions.push(suggestion);
        
        return {
          success: true,
          suggestion,
          spaceCatResult: result,
          site: {
            id: site.id,
            baseURL: site.baseURL
          },
          opportunityId: opportunity.id,
          message: `Successfully uploaded suggestion ${suggestionId} to SpaceCat for ${site.baseURL} (Site ID: ${site.id}, Opportunity ID: ${opportunity.id})`
        };
      } catch (apiError) {
        // If SpaceCat API fails, still track locally but report the error
        if (!dryRun) {
          this.approvedSuggestions.push(suggestion);
        }
        
        return {
          success: false,
          suggestion,
          error: `SpaceCat API error: ${apiError.message}`,
          message: `Failed to upload suggestion ${suggestionId} to SpaceCat: ${apiError.message}`
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
   * Clean up temporary files
   */
  cleanupTempFiles() {
    try {
      const files = fs.readdirSync(this.tempDir);
      let deletedCount = 0;
      
      files.forEach(file => {
        if (file.endsWith('.md')) {
          fs.unlinkSync(path.join(this.tempDir, file));
          deletedCount++;
        }
      });
      
      return {
        success: true,
        deletedCount,
        message: `Cleaned up ${deletedCount} temporary files`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      totalSuggestions: this.suggestions.length,
      editedSuggestions: this.editedSuggestions.size,
      approvedSuggestions: this.approvedSuggestions.length,
      currentFile: this.currentFile,
      tempFiles: fs.readdirSync(this.tempDir).filter(f => f.endsWith('.md')).length
    };
  }
}

// Create the MCP server
const server = new Server(
  {
    name: 'cwv-suggestion-manager',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Create manager instance
const manager = new CWVSuggestionManager();

// Register tools
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
        name: 'create_suggestion_editor',
        description: 'Create a temporary markdown file for editing a suggestion',
        inputSchema: {
          type: 'object',
          properties: {
            suggestionIndex: {
              type: 'string',
              description: 'Index of the suggestion to edit (1-based)'
            }
          },
          required: ['suggestionIndex']
        }
      },
      {
        name: 'read_suggestion_edits',
        description: 'Read back the edited suggestion from markdown file',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the edited markdown file'
            }
          },
          required: ['filePath']
        }
      },
      {
        name: 'upload_to_spacecat',
        description: 'Upload an approved suggestion to SpaceCat',
        inputSchema: {
          type: 'object',
          properties: {
            suggestionId: {
              type: 'string',
              description: 'ID of the suggestion to upload'
            },
            dryRun: {
              type: 'boolean',
              description: 'If true, simulate the upload without actually doing it',
              default: false
            }
          },
          required: ['suggestionId']
        }
      },
      {
        name: 'cleanup_temp_files',
        description: 'Remove temporary markdown editing files',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'get_status',
        description: 'Get current status of suggestions and workflow',
        inputSchema: {
          type: 'object',
          properties: {}
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
      case 'create_suggestion_editor':
        result = manager.createSuggestionEditor(args.suggestionIndex);
        break;
      case 'read_suggestion_edits':
        result = manager.readSuggestionEdits(args.filePath);
        break;
      case 'upload_to_spacecat':
        result = await manager.uploadToSpaceCat(args.suggestionId, args.dryRun);
        break;
      case 'cleanup_temp_files':
        result = manager.cleanupTempFiles();
        break;
      case 'get_status':
        result = { success: true, ...manager.getStatus() };
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
      text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }
      ],
      isError: true
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);