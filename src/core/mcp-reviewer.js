#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CWVSuggestionManager } from './suggestion-manager.js';

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