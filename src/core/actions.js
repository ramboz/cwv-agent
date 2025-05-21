import collecetAction from './collect.js';
import rulesAction from './rules.js';
// import runAgent from './agent.js';
import runPrompt from './multishot-prompt.js';
import { getNormalizedUrl } from '../utils.js';

export async function handleAgentAction(pageUrl, deviceType) {
  // const result = await runAgent(pageUrl, deviceType);
  // return result;
  return { error: "Agent action not implemented yet" };
}

export async function processUrl(pageUrl, action, deviceType, skipCache, outputSuffix, blockRequests, model) {
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
          model
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
        result = await handleAgentAction(normalizedUrl.url, deviceType);
        console.log(result.messages?.at(-1)?.content || result.content || result);
        if (result.usage_metadata) {
          console.log(result.usage_metadata);
        }
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