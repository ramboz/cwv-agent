import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import collectArtifacts from './collect.js';
import {
  initializeSystem,
  cruxStep,
  cruxSummaryStep,
  psiStep,
  psiSummaryStep,
  harStep,
  harSummaryStep,
  perfStep,
  perfSummaryStep,
  htmlStep,
  codeStep,
  rulesStep,
  actionPrompt,
  resetStepCounter,
  coverageStep,
  coverageSummaryStep,
} from '../prompts/index.js';
import { detectAEMVersion } from '../tools/aem.js';
import merge from '../tools/merge.js';
import { applyRules } from '../tools/rules.js';
import { estimateTokenSize, cacheResults, getCachedResults, getCachePath } from '../utils.js';
import { LLMFactory } from '../models/llm-factory.js';
import { DEFAULT_MODEL, getTokenLimits } from '../models/config.js';
import {runMultiAgents} from "./multi-agents.js";

/**
 * Extract structured JSON from the AI response and validate it
 */
function extractStructuredSuggestions(content, pageUrl, deviceType) {
  try {
    // Look for the "STRUCTURED DATA FOR AUTOMATION" section first
    const automationSectionMatch = content.match(/## STRUCTURED DATA FOR AUTOMATION[\s\S]*?```json\s*(\{[\s\S]*?\})\s*```/);
    
    // Fallback to general JSON code blocks or direct JSON
    const jsonMatch = automationSectionMatch || 
                     content.match(/```json\s*(\{[\s\S]*?\})\s*```/) || 
                     content.match(/(\{[\s\S]*"suggestions"[\s\S]*?\})/);
    
    if (!jsonMatch) {
      console.log('⚠️  No structured JSON found in AI response');
      console.log('⚠️  Looking for: ## STRUCTURED DATA FOR AUTOMATION section or ```json blocks');
      return null;
    }

    const jsonStr = jsonMatch[1];
    let parsedData;
    
    try {
      parsedData = JSON.parse(jsonStr);
    } catch (parseError) {
      console.log('⚠️  Failed to parse JSON from AI response:', parseError.message);
      return null;
    }

    // Validate the structure
    if (!parsedData.suggestions || !Array.isArray(parsedData.suggestions)) {
      console.log('⚠️  Invalid JSON structure: missing or invalid suggestions array');
      return null;
    }

    // Ensure required fields exist and add metadata
    const processedData = {
      ...parsedData,
      url: parsedData.url || pageUrl,
      deviceType: parsedData.deviceType || deviceType,
      extractedAt: new Date().toISOString(),
      suggestions: parsedData.suggestions.map((suggestion, index) => ({
        id: suggestion.id || (index + 1),
        title: suggestion.title || 'Untitled Suggestion',
        description: suggestion.description || '',
        metric: suggestion.metric || 'CWV',
        priority: suggestion.priority || 'Medium',
        effort: suggestion.effort || 'Medium',
        impact: suggestion.impact || '',
        implementation: suggestion.implementation || '',
        codeExample: suggestion.codeExample || '',
        category: suggestion.category || 'performance',
        ...suggestion // Include any additional fields
      }))
    };

    console.log(`✅ Extracted ${processedData.suggestions.length} structured suggestions`);
    return processedData;

  } catch (error) {
    console.log('⚠️  Error extracting structured data:', error.message);
    return null;
  }
}

/**
 * Creates message array with either full or summarized content
 */
function createMessages(pageData, useSummarized = false) {
  const {
    pageUrl, deviceType, cms, rulesSummary,
    resources, crux, psi, perfEntries, har,
    cruxSummary, psiSummary, perfEntriesSummary, harSummary,
    coverageData, coverageDataSummary,
  } = pageData;

  // Reset step counter before creating a new sequence of messages
  resetStepCounter();

  if (useSummarized) {
    return [
      new SystemMessage(initializeSystem(cms)),
      new HumanMessage(cruxSummaryStep(cruxSummary)),
      new HumanMessage(psiSummaryStep(psiSummary)),
      new HumanMessage(perfSummaryStep(perfEntriesSummary)),
      new HumanMessage(harSummaryStep(harSummary)),
      new HumanMessage(htmlStep(pageUrl, resources)),
      new HumanMessage(rulesStep(rulesSummary)),
      new HumanMessage(coverageSummaryStep(coverageDataSummary)),
      new HumanMessage(codeStep(pageUrl, resources, 10_000)),
      new HumanMessage(actionPrompt(pageUrl, deviceType)),
    ];
  } else {
    return [
      new SystemMessage(initializeSystem(cms)),
      new HumanMessage(cruxStep(crux)),
      new HumanMessage(psiStep(psi)),
      new HumanMessage(perfStep(perfEntries)),
      new HumanMessage(harStep(har)),
      new HumanMessage(htmlStep(pageUrl, resources)),
      new HumanMessage(rulesStep(rulesSummary)),
      new HumanMessage(coverageStep(coverageData)),
      new HumanMessage(codeStep(pageUrl, resources)),
      new HumanMessage(actionPrompt(pageUrl, deviceType)),
    ];
  }
}

/**
 * Invokes the LLM with a set of messages
 */
async function invokeLLM(llm, pageData, model, useSummarized = false) {
  const { pageUrl, deviceType } = pageData;
  const tokenLimits = getTokenLimits(model);
  const messages = createMessages(pageData, useSummarized);

  cacheResults(pageUrl, deviceType, 'prompt', messages);
  cacheResults(pageUrl, deviceType, 'prompt', messages.map((m) => m.content).join('\n---\n'));

  // Calculate token usage
  const enc = new Tiktoken(cl100k_base);
  const tokensLength = messages.map((m) => enc.encode(m.content).length).reduce((a, b) => a + b, 0);
  console.log(`Prompt Tokens${useSummarized ? ' (simplified)' : ''}:`, tokensLength);

  // Check if we need to switch to summarized version
  if (!useSummarized && tokensLength > (tokenLimits.input - tokenLimits.output) * .9) {
    console.log('Context window limit hit. Trying with summarized prompt...');
    return invokeLLM(llm, pageData, model, true);
  }

  try {
    // Direct invocation
    const result = await llm.invoke(messages);
    cacheResults(pageUrl, deviceType, 'report', result, '', model);
    const path = cacheResults(pageUrl, deviceType, 'report', result.content, '', model);
    console.log('✅ CWV report generated at:', path);
    
    // Extract and save structured JSON if present
    const structuredData = extractStructuredSuggestions(result.content, pageUrl, deviceType);
    if (structuredData) {
      const suggestionPath = cacheResults(pageUrl, deviceType, 'suggestions', structuredData, '', model);
      console.log('✅ Structured suggestions saved at:', suggestionPath);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Failed to generate report for', pageData.pageUrl);

    if (error.code === 400 && !useSummarized) { // Token limit reached, retry with summarized if we haven't yet
      console.log('Context window limit hit. Retrying with summarized prompt...');
      return invokeLLM(llm, pageData, model, true);
    } else if (error.code === 400) {
      console.log('Context window limit hit, even with summarized prompt.', error);
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
 * Invokes the LLM with a set of messages using multiple agents
 * @param pageData
 * @param model
 * @param llm
 * @returns {Promise<*>}
 */
async function invokeMultiAgentLLM(pageData, model, llm) {
  const {pageUrl, deviceType} = pageData;
  const tokenLimits = getTokenLimits(model);

  try {
    // Direct invocation
    const result = await runMultiAgents(pageData, tokenLimits, llm);
    cacheResults(pageUrl, deviceType, 'report', result, 'multi_agent', model);
    const resultPath = cacheResults(pageUrl, deviceType, 'report', result, 'multi_agent', model);
    console.log('✅ CWV report generated at:', resultPath);
    return result;

  } catch (error) {
    console.error('❌ Failed to generate report for', pageData.pageUrl);
    if (error.code === 400) {
      console.log('Context window limit hit, even with summarized prompt.', error);
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

export default async function runPrompt(pageUrl, deviceType, options = {}) {
  // Get model from options or use default
  const model = options.model || DEFAULT_MODEL;

  // Check cache first if not skipping
  let result;
  if (!options.skipCache) {
    result = getCachedResults(pageUrl, deviceType, 'report', '', model);
    if (result) {
      const path = getCachePath(pageUrl, deviceType, 'report', '', true, model);
      console.log('Report already exists at', path);
      return result;
    }
  }

  // Perform data collection before running the model, so we don't waste calls if an error occurs
  const {
    har,
    harSummary,
    psi,
    psiSummary,
    resources,
    crux,
    cruxSummary,
    perfEntries,
    perfEntriesSummary,
    fullHtml,
    jsApi,
    coverageData,
    coverageDataSummary,
  } = await collectArtifacts(pageUrl, deviceType, options);

  const report = merge(pageUrl, deviceType);
  const { summary: rulesSummary, fromCache } = await applyRules(pageUrl, deviceType, options, { crux, psi, har, perfEntries, resources, fullHtml, jsApi, report });
  if (fromCache) {
    console.log('✓ Loaded rules from cache. Estimated token size: ~', estimateTokenSize(rulesSummary));
  } else {
    console.log('✅ Processed rules. Estimated token size: ~', estimateTokenSize(rulesSummary));
  }

  const cms = detectAEMVersion(har.log.entries[0].headers, fullHtml);
  console.log('AEM Version:', cms);

  // Create LLM instance using the factory
  const llm = LLMFactory.createLLM(model, options.llmOptions || {});

  // Organize all data into one object for easier passing
  const pageData = {
    pageUrl, deviceType, cms, rulesSummary, resources,
    crux, psi, perfEntries, har, coverageData,
    cruxSummary, psiSummary, perfEntriesSummary, harSummary, coverageDataSummary,
  };

  // Invoke LLM and handle retries automatically
  if(options.agentMode === 'single') {
    return invokeLLM(llm, pageData, model, false);
  } else {
    return invokeMultiAgentLLM(pageData, model, llm);
  }
}
