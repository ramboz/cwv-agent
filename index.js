import dotenv from 'dotenv';
import { parseArguments } from './src/cli/cli.js';
import { loadUrls } from './src/cli/urlLoader.js';
import { processUrl } from './src/core/actions.js';

// Load environment variables
dotenv.config();

/**
 * Suppress all console output when in silent mode.
 * Useful for MCP mode where stdout must be clean JSON-RPC.
 */
function enableSilentMode() {
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
  console.debug = noop;
  console.group = noop;
  console.groupEnd = noop;
  console.table = noop;
}

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
  const rumDomainKey = argv.rumDomainKey;
  const silent = argv.silent;

  // Enable silent mode if requested (suppresses all console output)
  if (silent) {
    enableSilentMode();
  }

  // Handle MCP reviewer action separately
  if (action === 'mcp-reviewer') {
    // Note: No console output for MCP mode - it interferes with JSON-RPC protocol
    await processUrl(null, action, deviceType, skipCache, outputSuffix, blockRequests, model, rumDomainKey);
    return;
  }

  // Load URLs for other actions
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
    await processUrl(url, action, deviceType, skipCache, outputSuffix, blockRequests, model, rumDomainKey);

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
