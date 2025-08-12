import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';
import { CWVSuggestionManager } from './suggestion-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const manager = new CWVSuggestionManager();

export const suggestionReviewTools = {
  load_suggestions_by_url: {
    name: 'load_suggestions_by_url',
    description: 'Auto-discover and load CWV suggestions by URL.',
    inputSchema: {
      url: z.string().describe('The URL for which to load suggestions.'),
      cacheDir: z.string().optional().describe('The directory where suggestions are cached.'),
    },
    execute: async ({ url, cacheDir }) => manager.loadSuggestionsByUrl(url, cacheDir || path.join(__dirname, '..', '..', '.cache')),
  },
  create_category_editor: {
    name: 'create_category_editor',
    description: 'Create a temp markdown file for editing a category.',
    inputSchema: {
      category: z.enum(['LCP', 'CLS', 'INP', 'TTFB']).describe('The category to edit.'),
    },
    execute: async ({ category }) => manager.createCategoryEditor(category),
  },
  read_category_edits: {
    name: 'read_category_edits',
    description: 'Read back the edited category from markdown.',
    inputSchema: {
      filePath: z.string().describe('The path to the markdown file to read.'),
    },
    execute: async ({ filePath }) => manager.readCategoryEdits(filePath),
  },
  read_markdown_for_agent_parsing: {
    name: 'read_markdown_for_agent_parsing',
    description: 'Read raw markdown content for intelligent agent parsing of suggestions.',
    inputSchema: {
      filePath: z.string().describe('The path to the markdown file to read.'),
    },
    execute: async ({ filePath }) => manager.readMarkdownForAgentParsing(filePath),
  },
  update_suggestions_from_agent: {
    name: 'update_suggestions_from_agent',
    description: 'Update suggestions for a category with agent-parsed data.',
    inputSchema: {
      category: z.enum(['LCP', 'CLS', 'INP', 'TTFB']).describe('The category to update.'),
      suggestions: z.array(z.object({
        title: z.string(),
        description: z.string(),
        priority: z.string().optional(),
        effort: z.string().optional(),
        impact: z.string().optional(),
        implementation: z.string().optional(),
        codeExample: z.string().optional(),
        devices: z.array(z.string()).optional()
      })).describe('Array of parsed suggestion objects.'),
      status: z.enum(['approved', 'rejected', 'pending']).default('pending').describe('Approval status.')
    },
    execute: async ({ category, suggestions, status }) => manager.updateSuggestionsFromAgent(category, suggestions, status),
  },
  get_category_status: {
    name: 'get_category_status',
    description: 'Get status for a specific category or all.',
    inputSchema: {
      category: z.enum(['LCP', 'CLS', 'INP', 'TTFB']).optional().describe('The category to get status for. If omitted, returns all.'),
    },
    execute: async ({ category }) => manager.getCategoryStatus(category),
  },
  batch_upload_to_spacecat: {
    name: 'batch_upload_to_spacecat',
    description: 'Batch upload approved suggestions to SpaceCat.',
    inputSchema: {
      dryRun: z.boolean().default(false).describe('If true, performs a dry run without actual uploading.'),
    },
    execute: async ({ dryRun }) => manager.batchUploadToSpaceCat(dryRun),
  },
  get_status: {
    name: 'get_status',
    description: 'Get current status of the suggestion workflow.',
    inputSchema: {},
    execute: async () => manager.getStatus(),
  },
  cleanup_temp_files: {
    name: 'cleanup_temp_files',
    description: 'Remove temporary markdown editing files.',
    inputSchema: {
      fileType: z.enum(['all', 'category']).default('all').describe('The type of temp files to clean up.'),
    },
    execute: async ({ fileType }) => manager.cleanupTempFiles(fileType),
  },
  check_existing_suggestions: {
    name: 'check_existing_suggestions',
    description: 'Check if suggestions already exist for the current URL in SpaceCat.',
    inputSchema: {},
    execute: async () => manager.checkExistingSuggestionsForUrl(),
  },
  approve_category: {
    name: 'approve_category',
    description: 'Approve all suggestions in a category.',
    inputSchema: {
      category: z.enum(['LCP', 'CLS', 'INP', 'TTFB']).describe('The category to approve.'),
    },
    execute: async ({ category }) => manager.approveCategory(category),
  },
};