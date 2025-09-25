#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

async function testMCP() {
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error('ListToolsRequest received'); // Debug log to stderr
    return {
      tools: [
        {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message']
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    console.error('CallToolRequest received:', request.params.name); // Debug log to stderr
    const { name, arguments: args } = request.params;
    return { content: [{ type: 'text', text: `Test tool called with: ${JSON.stringify(args)}` }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('MCP server started successfully'); // Debug log to stderr
  process.stdin.resume();
}

testMCP().catch(error => {
  console.error('MCP server error:', error);
  process.exit(1);
}); 