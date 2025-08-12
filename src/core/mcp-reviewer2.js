#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dataTools } from './mcp-data-tools.js';
import { suggestionReviewTools } from './mcp-review-tools.js';
import dotenv from 'dotenv';

dotenv.config();

export async function startMCPReviewer() {
  const allTools = {
    ...dataTools,
    ...suggestionReviewTools,
  };

  const server = new McpServer({
    name: 'cwv-agent-dynamic-reviewer',
    version: '2.0.0',
  });

  Object.entries(allTools).forEach(([id, tool]) => {
    const { title, description, inputSchema, execute } = tool;
    server.registerTool(id, { title, description, inputSchema }, execute);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url.startsWith('file://') && process.argv[1] === fileURLToPath(import.meta.url)) {
  startMCPReviewer().catch(err => {
    console.error('MCP Server failed to start:', err);
    process.exit(1);
  });
} 