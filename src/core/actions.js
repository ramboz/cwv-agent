import collecetAction from './collect.js';
import rulesAction from './rules.js';
import runPrompt from './multishot-prompt.js';
import { startMCPReviewer } from './mcp-reviewer.js';
import { getNormalizedUrl, getCachePath } from '../utils.js';
import { runAgentFlow } from './multi-agents.js';

export async function processUrl(pageUrl, action, deviceType, skipCache, outputSuffix, blockRequests, model, agentMode) {
  // Handle MCP reviewer action separately (doesn't need URL processing)
  if (action === 'mcp-reviewer') {
    // Note: No console output for MCP mode - it interferes with JSON-RPC protocol
    return await startMCPReviewer();
    // This should never return since startMCPReviewer() runs indefinitely
  }
  console.group(`Processing: ${pageUrl}`);

  try {
    const normalizedUrl = await getNormalizedUrl(pageUrl, deviceType);
    if (!normalizedUrl?.url) {
      throw new Error(`Failed to access: ${pageUrl}`);
    }
    if (normalizedUrl.url !== pageUrl) {
      console.log('Normalized URL:', normalizedUrl.url, normalizedUrl.skipTlsCheck ? '(invalid TLS check)' : '');
    }

    let result;

    switch (action) {
      case 'prompt':
        result = await runPrompt(normalizedUrl.url, deviceType, {
          skipCache,
          skipTlsCheck: normalizedUrl.skipTlsCheck,
          outputSuffix,
          blockRequests,
          model,
        });
        break;

      case 'collect':
        result = await collecetAction(normalizedUrl.url, deviceType, { skipCache, skipTlsCheck: normalizedUrl.skipTlsCheck, outputSuffix, blockRequests });
        console.log('Done. Check the `.cache` folder');
        break;

      case 'rules':
        result = await rulesAction(normalizedUrl.url, deviceType, { skipCache, skipTlsCheck: normalizedUrl.skipTlsCheck, outputSuffix, blockRequests });
        break;

        case 'agent':
          result = await runAgentFlow(normalizedUrl.url, deviceType, {
            skipCache,
            skipTlsCheck: normalizedUrl.skipTlsCheck,
            outputSuffix,
            blockRequests,
            model,
            agentMode,
          });
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    console.groupEnd();
    return result;
  } catch (error) {
    console.error(`❌ Error processing ${pageUrl}:`, error);
    console.groupEnd();
    return { error: error.message };
  }
}
