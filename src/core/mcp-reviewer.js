#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CWVSuggestionManager } from './suggestion-manager.js';
import { runAgentFlow } from './multi-agents.js';
import { getNormalizedUrl, getCachePath } from '../utils.js';

/**
 * Run the multi-agent CWV analysis workflow.
 * @param {Object} args - Tool arguments
 * @param {string} args.url - URL to analyze
 * @param {string} [args.device='mobile'] - Device type
 * @param {boolean} [args.skipCache=false] - Skip cache
 * @param {string} [args.model] - LLM model to use
 * @param {string} [args.blockRequests] - URL patterns to block
 * @returns {Promise<Object>} Result with file paths and status
 */
async function runAgentTool(args) {
  const { url, device = 'mobile', skipCache = false, model, blockRequests } = args;

  if (!url) {
    throw new Error('URL is required');
  }

  const startTime = Date.now();

  // Normalize the URL first
  const normalizedUrl = await getNormalizedUrl(url, device);
  if (!normalizedUrl?.url) {
    throw new Error(`Failed to access: ${url}`);
  }

  // Run the multi-agent flow
  const result = await runAgentFlow(normalizedUrl.url, device, {
    skipCache,
    skipTlsCheck: normalizedUrl.skipTlsCheck,
    outputSuffix: '',
    blockRequests: blockRequests || '',
    model,
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  if (result?.error) {
    return {
      success: false,
      error: result.error,
      duration: `${duration}s`,
    };
  }

  // Get paths to generated files
  const suggestionsPath = getCachePath(normalizedUrl.url, device, 'suggestions', '', false, model);
  const reportPath = getCachePath(normalizedUrl.url, device, 'report', '', true, model);

  return {
    success: true,
    url: normalizedUrl.url,
    device,
    duration: `${duration}s`,
    files: {
      suggestions: suggestionsPath,
      report: reportPath,
    },
    message: `Analysis completed. Use load_suggestions_by_url to review the results.`,
  };
}

/**
 * Start MCP reviewer action
 */
export async function startMCPReviewer() {
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

  const manager = new CWVSuggestionManager({ isMCPMode: true });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'load_cwv_suggestions',
          description: 'Load CWV suggestions from a single local JSON file (from disk cache, not SpaceCat)',
          inputSchema: {
            type: 'object',
            properties: { filePath: { type: 'string', description: 'Path to the suggestions JSON file' } },
            required: ['filePath']
          }
        },
        {
          name: 'load_multi_device_suggestions',
          description: 'Load and merge CWV suggestions from both mobile and desktop local JSON files (from disk cache, not SpaceCat)',
          inputSchema: {
            type: 'object',
            properties: {
              mobileFilePath: { type: 'string', description: 'Path to the mobile suggestions JSON file' },
              desktopFilePath: { type: 'string', description: 'Path to the desktop suggestions JSON file (optional)' }
            },
            required: ['mobileFilePath']
          }
        },
        {
          name: 'load_suggestions_by_url',
          description: 'Auto-discover and load CWV suggestions from local cache files by URL (searches .cache directory, not SpaceCat)',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to load suggestions for' },
              cacheDir: { type: 'string', description: 'Cache directory to search in', default: './.cache' }
            },
            required: ['url']
          }
        },
        {
          name: 'get_suggestions_by_url_and_type',
          description: 'Fetch existing suggestions from SpaceCat/AEM Sites Optimizer (ASO) database by URL and opportunity type (e.g., cwv, a11y). This queries the live SpaceCat API.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The URL to check for.' },
              opportunityType: { type: 'string', description: 'The type of opportunity (e.g., cwv, a11y). Defaults to cwv.', default: 'cwv' }
            },
            required: ['url']
          }
        },
        {
          name: 'create_category_editor',
          description: 'Create a temporary markdown file for editing an entire category of suggestions (requires suggestions to be loaded first)',
          inputSchema: {
            type: 'object',
            properties: {
              category: { type: 'string', description: 'Category to edit (LCP, CLS, INP, or TTFB)', enum: ['LCP', 'CLS', 'INP', 'TTFB'] }
            },
            required: ['category']
          }
        },
        {
          name: 'read_category_edits',
          description: 'Read back the edited category from markdown file and update approval status',
          inputSchema: {
            type: 'object',
            properties: { filePath: { type: 'string', description: 'Path to the edited category markdown file' } },
            required: ['filePath']
          }
        },
        {
          name: 'check_existing_suggestions',
          description: 'Check if suggestions already exist in SpaceCat/AEM Sites Optimizer (ASO) for the currently loaded URL (requires URL to be loaded first via load_suggestions_by_url)',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'get_category_status',
          description: 'Get approval status and count for a specific category or all categories (requires suggestions to be loaded first)',
          inputSchema: {
            type: 'object',
            properties: {
              category: { type: 'string', description: 'Specific category to get status for', enum: ['LCP', 'CLS', 'INP', 'TTFB'] }
            }
          }
        },
        {
          name: 'approve_category',
          description: 'Approve all suggestions in a category for upload to SpaceCat/AEM Sites Optimizer (ASO) (requires suggestions to be loaded first)',
          inputSchema: {
            type: 'object',
            properties: {
              category: { type: 'string', description: 'Category to approve', enum: ['LCP', 'CLS', 'INP', 'TTFB'] }
            },
            required: ['category']
          }
        },
        {
          name: 'batch_upload_to_spacecat',
          description: 'Upload all approved category suggestions to SpaceCat/AEM Sites Optimizer (ASO) (creates new or updates existing suggestions for the URL)',
          inputSchema: {
            type: 'object',
            properties: {
              dryRun: { type: 'boolean', description: 'If true, simulate the upload without making changes', default: false }
            }
          }
        },
        {
          name: 'get_status',
          description: 'Get current status of loaded suggestions, approval state, and workflow progress',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'cleanup_temp_files',
          description: 'Remove temporary markdown editing files from the .cache/temp-edits directory',
          inputSchema: {
            type: 'object',
            properties: {
              fileType: { type: 'string', description: 'Type of files to clean up', enum: ['all', 'category', 'suggestion', 'markdown'], default: 'all' }
            }
          }
        },
        {
          name: 'run_agent',
          description: 'Run full multi-agent CWV analysis workflow for a URL. Collects performance data (CrUX, PSI, HAR, code coverage) and generates AI-powered optimization suggestions. Takes 3-5 minutes to complete.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to analyze' },
              device: { type: 'string', description: 'Device type for analysis', enum: ['mobile', 'desktop'], default: 'mobile' },
              skipCache: { type: 'boolean', description: 'Force fresh data collection, ignoring cache', default: false },
              model: { type: 'string', description: 'LLM model to use (e.g., "gemini-2.5-pro-preview-05-06")' },
              blockRequests: { type: 'string', description: 'Comma-separated list of URL patterns to block (e.g., "google-analytics,facebook")' }
            },
            required: ['url']
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      switch (name) {
        case 'load_cwv_suggestions':
          result = manager.loadMultiDeviceSuggestions(args.filePath);
          break;
        case 'load_multi_device_suggestions':
          result = manager.loadMultiDeviceSuggestions(args.mobileFilePath, args.desktopFilePath);
          break;
        case 'load_suggestions_by_url':
          result = manager.loadSuggestionsByUrl(args.url, args.cacheDir);
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
        case 'approve_category':
          result = manager.approveCategory(args.category);
          break;
        case 'get_suggestions_by_url_and_type':
          result = await manager.getSuggestionsByUrlAndType(args.url, args.opportunityType);
          break;
        case 'run_agent':
          result = await runAgentTool(args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  const cleanup = () => {
    if (manager) manager.cleanup();
    server.close();
    process.exit(0);
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  process.stdin.resume();
} 