import collectArtifacts from './collect.js';
import merge from '../tools/merge.js';
import rules from '../rules/index.js';
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

async function applyRules({ pageUrl, deviceType, crux, psi, har, perfEntries, resources, report }) {
  // Sort report.data by start time
  report.data.sort((a, b) => a.start - b.start);
  // Clone report.data and sort by end time
  report.dataSortedByEnd = report.data.slice().sort((a, b) => a.end - b.end);

  const results = await Promise.all(rules.map((r) => r({ summary: { url: pageUrl, type: deviceType }, crux, psi, har, perfEntries, resources, report })));
  return results.flat().filter(r => r);
}

export async function handleCollectAction(pageUrl, deviceType, options) {
  const {
    har,
    psi,
    resources,
    perfEntries,
    crux,
  } = await collectArtifacts(pageUrl, deviceType, options);

  const report = merge(pageUrl, deviceType);
  
  const results = await applyRules({ pageUrl, deviceType, crux, psi, har, perfEntries, resources, report });
  return {
    failedRules: results.filter(r => !r.passing)
  };
}

export async function handleRulesAction(pageUrl, deviceType) {
  // const crux = await readCache(pageUrl, deviceType, 'crux');
  // const psi = await readCache(pageUrl, deviceType, 'psi');
  const har = await readCache(pageUrl, deviceType, 'har');
  const perfEntries = await readCache(pageUrl, deviceType, 'perf');
  // const resources = await readCache(pageUrl, deviceType, 'resources');
  const report = await readCache(pageUrl, deviceType, 'report');

  // const results = await applyRules({ pageUrl, deviceType, crux, psi, har, perfEntries, resources, report });
  const results = await applyRules({ pageUrl, deviceType, har, perfEntries, report });
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
    if (!normalizedUrl?.url) {
      throw new Error(`Failed to access: ${pageUrl}`);
    }
    console.log('Normalized URL:', normalizedUrl.url, normalizedUrl.skipTlsCheck ? '(invalid TLS check)' : '');
    
    let result;
    
    switch (action) {
      case 'prompt':
        result = await handlePromptAction(normalizedUrl.url, deviceType, { skipCache, skipTlsCheck: normalizedUrl.skipTlsCheck });
        break;
        
      case 'collect':
        result = await handleCollectAction(normalizedUrl.url, deviceType, { skipCache, skipTlsCheck: normalizedUrl.skipTlsCheck });
        result.failedRules.forEach(r => console.log('Failed', r.message, ':', r.recommendation));
        cacheResults(normalizedUrl.url, deviceType, 'recommendations', result);
        console.log('Done. Check the `.cache` folder');
        break;

      case 'rules':
        result = await handleRulesAction(normalizedUrl.url, deviceType);
        result.failedRules.forEach(r => console.log('Failed', r.time, r.message, ':', r.recommendation));
        cacheResults(normalizedUrl.url, deviceType, 'recommendations', result);
        console.log('Done. Check the `.cache` folder');
        break;
        
      case 'merge':
        result = await handleMergeAction(normalizedUrl.url, deviceType);
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