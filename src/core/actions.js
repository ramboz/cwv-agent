import collecetAction from './collect.js';
import rulesAction from './rules.js';
// import runAgent from './agent.js';
import runPrompt from './multishot-prompt.js';
import { cacheResults, getCachedResults, getNormalizedUrl, readCache } from '../utils.js';

export async function handlePromptAction(pageUrl, deviceType, options) {
  // Check cache first if not skipping
  let result;
  if (!options.skipCache) {
    result = getCachedResults(pageUrl, deviceType, 'report');
    if (result) {
      console.log('Using cached report...');
    }
  }
  
  // If no cached result or skipping cache, run the prompt
  if (!result) {
    result = await runPrompt(pageUrl, deviceType, options);
    if (result instanceof Error) {
      console.error('❌ Failed to generate report for', pageUrl);
    }
    else {
      cacheResults(pageUrl, deviceType, 'report', result);
      cacheResults(pageUrl, deviceType, 'report', result.content);
      console.log('✅ CWV report generated.');
    }
  }
  
  return result;
}

export async function handleAgentAction(pageUrl, deviceType) {
  // const result = await runAgent(pageUrl, deviceType);
  // return result;
  return { error: "Agent action not implemented yet" };
}

export async function processUrl(pageUrl, action, deviceType, skipCache, outputSuffix, blockRequests) {
  console.group(`Processing: ${pageUrl}`);
  
  try {
    const normalizedUrl = await getNormalizedUrl(pageUrl);
    if (!normalizedUrl?.url) {
      throw new Error(`Failed to access: ${pageUrl}`);
    }
    console.log('Normalized URL:', normalizedUrl.url, normalizedUrl.skipTlsCheck ? '(invalid TLS check)' : '');
    
    let result;
    
    switch (action) {
      case 'prompt':
        result = await handlePromptAction(normalizedUrl.url, deviceType, { skipCache, skipTlsCheck: normalizedUrl.skipTlsCheck, blockRequests });
        break;
        
      case 'collect':
        result = await collecetAction(normalizedUrl.url, deviceType, { skipCache, skipTlsCheck: normalizedUrl.skipTlsCheck, blockRequests });
        console.log('Done. Check the `.cache` folder');
        break;

      case 'rules':
        result = await rulesAction(normalizedUrl.url, deviceType, { skipCache, skipTlsCheck: normalizedUrl.skipTlsCheck, blockRequests });
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