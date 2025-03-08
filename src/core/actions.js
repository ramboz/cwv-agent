import collectArtifacts from './collect.js';
import merge from '../tools/merge.js';
import rules from '../rules/index.js';
// import runAgent from './agent.js';
import runPrompt from './multishot-prompt.js';
import { cacheResults, getCachedResults, getNormalizedUrl } from '../utils.js';

export async function handlePromptAction(pageUrl, deviceType, skipCache) {
  // Check cache first if not skipping
  let result;
  if (!skipCache) {
    result = getCachedResults(pageUrl, deviceType, 'report');
    if (result) {
      console.log('Using cached report...');
    }
  }
  
  // If no cached result or skipping cache, run the prompt
  if (!result) {
    console.log('Generating new report...');
    result = await runPrompt(pageUrl, deviceType, skipCache);
    cacheResults(pageUrl, deviceType, 'report', result);
  }
  
  return result;
}

export async function handleCollectAction(pageUrl, deviceType, skipCache) {
  const {
    har,
    psi,
    resources,
    perfEntries,
    crux,
  } = await collectArtifacts(pageUrl, deviceType, skipCache);
  
  const results = await Promise.all(rules.map((r) => r({}, crux, psi, har, perfEntries, resources)));
  
  return {
    failedRules: results.filter(r => !r.passing)
  };
}

export async function handleMergeAction(pageUrl, deviceType) {
  merge(pageUrl, deviceType);
  return { success: true };
}

export async function handleAgentAction(pageUrl, deviceType) {
  // const result = await runAgent(pageUrl, deviceType);
  // return result;
  return { error: "Agent action not implemented yet" };
}

export async function processUrl(pageUrl, action, deviceType, skipCache) {
  console.group(`Processing: ${pageUrl}`);
  
  try {
    const normalizedUrl = await getNormalizedUrl(pageUrl);
    if (!normalizedUrl) {
      throw new Error(`Failed to access: ${pageUrl}`);
    }
    
    let result;
    
    switch (action) {
      case 'prompt':
        result = await handlePromptAction(normalizedUrl, deviceType, skipCache);
        console.log(result.messages?.at(-1)?.content || result.kwargs?.content || result.content || result);
        if (result.kwargs?.usage_metadata || result.usage_metadata) {
          console.log(result.kwargs?.usage_metadata || result.usage_metadata);
        }
        break;
        
      case 'collect':
        result = await handleCollectAction(normalizedUrl, deviceType, skipCache);
        result.failedRules.forEach(r => console.log('Failed', r.message, ':', r.recommendation));
        console.log('Done. Check the `.cache` folder');
        break;
        
      case 'merge':
        result = await handleMergeAction(normalizedUrl, deviceType);
        console.log('Done. Check the `.cache` folder');
        break;
        
      case 'agent':
        result = await handleAgentAction(normalizedUrl, deviceType);
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
    console.error(`Error processing ${pageUrl}:`, error);
    console.groupEnd();
    return { error: error.message };
  }
} 