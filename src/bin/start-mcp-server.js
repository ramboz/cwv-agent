#!/usr/bin/env node

import { server, httpServer } from '../services/mcp-server.js';

// This file is intentionally minimal as most of the 
// server setup is done in the mcp-server.js file

// This exists primarily to provide a clean entry point for running the server

console.log('MCP server started. Use Ctrl+C to stop.');

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing MCP server');
  httpServer.close(() => {
    console.log('MCP server closed');
    process.exit(0);
  });
});

// Keep the process running
process.stdin.resume(); 