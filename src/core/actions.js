import collecetAction from './collect.js';
import rulesAction from './rules.js';
// import runAgent from './agent.js';
import runPrompt from './multishot-prompt.js';
import runAccessibilityAnalysis from './accessibility.js';
import { createGitHubClient } from '../tools/github.js';
import { getNormalizedUrl, getCachedResults } from '../utils.js';

export async function handleAgentAction(pageUrl, deviceType) {
  // const result = await runAgent(pageUrl, deviceType);
  // return result;
  return { error: "Agent action not implemented yet" };
}

export async function processUrl(pageUrl, action, deviceType, skipCache, outputSuffix, blockRequests, model, repo) {
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
      case 'collect':
        result = await collecetAction(normalizedUrl.url, deviceType, { 
          skipCache, 
          skipTlsCheck: normalizedUrl.skipTlsCheck, 
          outputSuffix, 
          blockRequests,
          model
        });
        break;
        
      case 'prompt':
        result = await runPrompt(normalizedUrl.url, deviceType, { 
          skipCache, 
          skipTlsCheck: normalizedUrl.skipTlsCheck, 
          outputSuffix, 
          blockRequests,
          model
        });
        break;
        
      case 'rules':
        result = await rulesAction(normalizedUrl.url, deviceType, { 
          skipCache, 
          skipTlsCheck: normalizedUrl.skipTlsCheck, 
          outputSuffix, 
          blockRequests,
          model
        });
        break;
        
      case 'agent':
        result = await handleAgentAction(normalizedUrl.url, deviceType);
        console.log(result.messages?.at(-1)?.content || result.content || result);
        if (result.usage_metadata) {
          console.log(result.usage_metadata);
        }
        break;
        
      case 'accessibility':
        result = await runAccessibilityAnalysis(normalizedUrl.url, deviceType, { 
          skipCache, 
          skipTlsCheck: normalizedUrl.skipTlsCheck, 
          outputSuffix, 
          blockRequests,
          model
        });
        break;
        
      case 'accessibility-collect':
        // Separate accessibility data collection that doesn't interfere with original
        console.log('Running separate accessibility data collection...');
        
        // First ensure we have basic HTML data
        const htmlData = getCachedResults(normalizedUrl.url, deviceType, 'html');
        if (!htmlData) {
          console.log('No HTML data found. Running basic collect first...');
          await collecetAction(normalizedUrl.url, deviceType, { 
            skipCache, 
            skipTlsCheck: normalizedUrl.skipTlsCheck, 
            outputSuffix, 
            blockRequests,
            model
          });
        }
        
        // Then run accessibility-specific collection
        result = await runAccessibilityAnalysis(normalizedUrl.url, deviceType, { 
          skipCache, 
          skipTlsCheck: normalizedUrl.skipTlsCheck, 
          outputSuffix, 
          blockRequests,
          model,
          collectSourceFiles: true 
        });
        break;
          
      case 'accessibility-pr':
        // Create GitHub PR with accessibility fixes
        console.log('Creating GitHub PR with accessibility fixes...');
        
        if (!repo) {
          throw new Error('Repository is required for PR creation. Use --repo owner/repo-name');
        }
        
        const [owner, repoName] = repo.split('/');
        if (!owner || !repoName) {
          throw new Error('Repository format should be owner/repo-name');
        }
        
        const github = createGitHubClient();
        result = await github.createAccessibilityPR_Complete(normalizedUrl.url, deviceType, owner, repoName, { 
          skipCache, 
          skipTlsCheck: normalizedUrl.skipTlsCheck, 
          outputSuffix, 
          blockRequests,
          model
        });
        break;
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    console.groupEnd();
    return result;
    
  } catch (error) {
    console.groupEnd();
    throw error;
  }
}