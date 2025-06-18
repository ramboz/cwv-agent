import dotenv from 'dotenv';
import { parseArguments } from './src/cli/cli.js';
import { loadUrls } from './src/cli/urlLoader.js';
import { processUrl } from './src/core/actions.js';

// Load environment variables
dotenv.config();

async function main() {
  // Parse command line arguments
  const argv = parseArguments();

  // Extract parameters
  const action = argv.action;
  const deviceType = argv.device;
  const skipCache = argv.skipCache;
  const outputSuffix = argv.outputSuffix;
  const blockRequests = argv.blockRequests;
  const model = argv.model;
  
  // Handle MCP reviewer action separately
  if (action === 'mcp-reviewer') {
    // Note: No console output for MCP mode - it interferes with JSON-RPC protocol
    await processUrl(null, action, deviceType, skipCache, outputSuffix, blockRequests, model);
    return;
  }
  
  // Load URLs for other actions
  const agentMode = argv.agentMode;

  // Load URLs
  const urls = loadUrls(argv);

  console.log(`Running ${action} for ${urls.length} URL(s) on ${deviceType}...`);
  if (skipCache) {
    console.log('Cache is disabled. Forcing new data collection.');
  }
  if (model) {
    console.log(`Using model: ${model}`);
  }

  // Process each URL
  for (const url of urls) {
    await processUrl(url, action, deviceType, skipCache, outputSuffix, blockRequests, model, agentMode);

    // Small delay between processing URLs
    if (urls.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 60_000)); // 1min
    }
  }
}

// Run the main function
main().catch(error => {
  // Only log to stderr (not stdout) and only exit for non-MCP actions
  console.error('Fatal error:', error);
  // Don't exit if we're running MCP server (it should handle its own errors)
  if (!process.argv.includes('mcp-reviewer')) {
    process.exit(1);
  }
});
