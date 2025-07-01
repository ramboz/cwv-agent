import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import { 
  initializeAccessibilitySystem,
  htmlAnalysisStep,
  sourceCodeAnalysisStep,
  accessibilityPrompt,
  resetStepCounter,
} from '../prompts/accessibility.js';
import { getCachedResults, cacheResults, getCachePath, estimateTokenSize } from '../utils.js';
import { collect as collectCode } from '../tools/code.js';
import { LLMFactory } from '../models/llm-factory.js';
import { DEFAULT_MODEL, getTokenLimits } from '../models/config.js';

/**
 * Collects source code files specifically for accessibility analysis.
 * This is separate from the main collect flow to avoid interference.
 * 
 * @param {string} pageUrl - The URL to analyze
 * @param {string} deviceType - Device type (mobile/desktop)
 * @param {Object} options - Collection options
 * @returns {Object} Collected source files relevant to accessibility
 */
async function collectAccessibilitySourceFiles(pageUrl, deviceType, options = {}) {
  console.log('Collecting source code files for accessibility analysis...');
  
  // Get HAR data to find resource URLs
  const harData = getCachedResults(pageUrl, deviceType, 'har');
  if (!harData || !harData.log || !harData.log.entries) {
    console.warn('No HAR data found. Cannot collect source code files.');
    return {};
  }

  // Extract URLs from HAR entries
  const resourceUrls = harData.log.entries.map(entry => entry.request.url);
  console.log(`Found ${resourceUrls.length} resources in HAR data`);

  // Use the existing code collection tool with accessibility-specific caching
  try {
    const { codeFiles, stats } = await collectCode(pageUrl, deviceType, resourceUrls, {
      skipCache: options.skipCache || false,
      skipTlsCheck: options.skipTlsCheck || false
    });

    console.log(`Collected ${stats.successful} source files (${stats.fromCache} from cache, ${stats.failed} failed)`);
    
    // Filter to only relevant files for accessibility analysis
    const relevantFiles = {};
    Object.entries(codeFiles).forEach(([url, content]) => {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      
      // Keep HTL templates, JS, CSS, and HTML files
      if (pathname.endsWith('.html') || 
          pathname.endsWith('.js') || 
          pathname.endsWith('.css') ||
          pathname.includes('/etc.clientlibs/')) {
        relevantFiles[url] = content;
      }
    });

    console.log(`Filtered to ${Object.keys(relevantFiles).length} relevant source files`);
    
    // Cache the collected source files specifically for accessibility
    cacheResults(pageUrl, deviceType, 'accessibility-source-files', relevantFiles);
    
    return relevantFiles;
    
  } catch (error) {
    console.error('Failed to collect source code files:', error.message);
    return {};
  }
}

/**
 * Creates message array for accessibility analysis
 * 
 * @param {Object} pageData - Page data including URL, HTML, and source files
 * @returns {Array} Array of messages for LLM analysis
 */
function createAccessibilityMessages(pageData) {
  const { pageUrl, deviceType, fullHtml, sourceFiles } = pageData;

  // Reset step counter before creating a new sequence of messages
  resetStepCounter();

  const messages = [
    new SystemMessage(initializeAccessibilitySystem()),
    new HumanMessage(htmlAnalysisStep(pageUrl, fullHtml))
  ];

  // Only add source code analysis if we have source files
  if (sourceFiles && Object.keys(sourceFiles).length > 0) {
    messages.push(new HumanMessage(sourceCodeAnalysisStep(pageUrl, sourceFiles)));
  }

  messages.push(new HumanMessage(accessibilityPrompt(pageUrl, deviceType)));

  return messages;
}

/**
 * Invokes the LLM for accessibility analysis with token management
 * 
 * @param {Object} llm - LLM instance
 * @param {Object} pageData - Page data for analysis
 * @param {string} model - Model name for token limits
 * @returns {Object} LLM response or error
 */
async function invokeAccessibilityLLM(llm, pageData, model) {
  const { pageUrl, deviceType } = pageData;
  const tokenLimits = getTokenLimits(model);
  const messages = createAccessibilityMessages(pageData);

  cacheResults(pageUrl, deviceType, 'accessibility-prompt', messages);
  cacheResults(pageUrl, deviceType, 'accessibility-prompt', messages.map((m) => m.content).join('\n---\n'));

  // Calculate token usage
  const enc = new Tiktoken(cl100k_base);
  const tokensLength = messages.map((m) => enc.encode(m.content).length).reduce((a, b) => a + b, 0);
  console.log(`Accessibility prompt tokens:`, tokensLength);

  // Check if we need to truncate content
  if (tokensLength > (tokenLimits.input - tokenLimits.output) * .9) {
    console.log('Context window limit hit. Truncating content...');
    const maxContentTokens = (tokenLimits.input - tokenLimits.output) * 0.7;
    
    // Prioritize source files over HTML for better fixes
    const sourceTokens = enc.encode(JSON.stringify(pageData.sourceFiles)).length;
    const htmlTokens = enc.encode(pageData.fullHtml).length;
    
    if (sourceTokens + htmlTokens > maxContentTokens) {
      // Truncate HTML first, keep source files
      if (htmlTokens > maxContentTokens * 0.3) {
        const truncatedHtml = enc.decode(enc.encode(pageData.fullHtml).slice(0, maxContentTokens * 0.3));
        pageData.fullHtml = truncatedHtml + '\n<!-- HTML content truncated due to token limits -->';
      }
      
      // If still too large, truncate source files
      if (sourceTokens > maxContentTokens * 0.7) {
        const prioritizedFiles = {};
        Object.entries(pageData.sourceFiles).forEach(([path, content]) => {
          if (path.includes('.html') || path.includes('.js') || path.includes('.css')) {
            prioritizedFiles[path] = content;
          }
        });
        pageData.sourceFiles = prioritizedFiles;
      }
      
      return invokeAccessibilityLLM(llm, pageData, model);
    }
  }

  try {
    const result = await llm.invoke(messages);
    cacheResults(pageUrl, deviceType, 'accessibility-report', result, '', model);
    const path = cacheResults(pageUrl, deviceType, 'accessibility-report', result.content, '', model);
    console.log('Accessibility report generated at:', path);
    return result;
  } catch (error) {
    console.error('Failed to generate accessibility report for', pageData.pageUrl);

    if (error.code === 400) {
      console.log('Context window limit hit.', error);
    } else if (error.code === 403) {
      console.log('Invalid API key.', error.message);
    } else if (error.status === 429) {
      console.log('Rate limit hit. Try again in 5 mins...', error);
    } else {
      console.error(error);
    }
    return error;
  }
}

/**
 * Main accessibility analysis function - completely separate from original collect flow
 * 
 * @param {string} pageUrl - URL to analyze
 * @param {string} deviceType - Device type (mobile/desktop)
 * @param {Object} options - Analysis options
 * @returns {Object} Analysis result
 */
export default async function runAccessibilityAnalysis(pageUrl, deviceType, options = {}) {
  console.log('Starting accessibility analysis...');
  
  // Get model from options or use default
  const model = options.model || DEFAULT_MODEL;
  
  // Check cache first if not skipping
  let result;
  if (!options.skipCache) {
    result = getCachedResults(pageUrl, deviceType, 'accessibility-report', '', model);
    if (result) {
      const path = getCachePath(pageUrl, deviceType, 'accessibility-report', '', true, model);
      console.log('Accessibility report already exists at', path);
      return result;
    }
  }

  // Get cached HTML data (from original collect flow)
  const fullHtml = getCachedResults(pageUrl, deviceType, 'html');
  if (!fullHtml) {
    throw new Error('No cached HTML data found. Please run "collect" action first to gather page data.');
  }

  console.log('Loaded HTML from cache. Estimated token size: ~', estimateTokenSize(fullHtml));

  // Check if we already have cached accessibility source files
  let sourceFiles = {};
  if (!options.skipCache) {
    sourceFiles = getCachedResults(pageUrl, deviceType, 'accessibility-source-files') || {};
    if (Object.keys(sourceFiles).length > 0) {
      console.log(`Loaded ${Object.keys(sourceFiles).length} source files from cache`);
    }
  }

  // If no cached source files, collect them separately
  if (Object.keys(sourceFiles).length === 0) {
    sourceFiles = await collectAccessibilitySourceFiles(pageUrl, deviceType, {
      skipCache: options.skipCache,
      skipTlsCheck: options.skipTlsCheck
    });
  }

  // Create LLM instance using the factory
  const llm = LLMFactory.createLLM(model, options.llmOptions || {});

  // Organize data for accessibility analysis
  const pageData = {
    pageUrl,
    deviceType,
    fullHtml,
    sourceFiles,
  };

  // Invoke LLM for accessibility analysis
  return invokeAccessibilityLLM(llm, pageData, model);
} 