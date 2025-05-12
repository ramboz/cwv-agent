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
  resetStepCounter
} from '../prompts/index.js';
import MCPClient from '../services/mcp-client.js';
import { estimateTokenSize, cacheResults, getCachedResults, getCachePath } from '../utils.js';
import { LLMFactory } from '../models/llm-factory.js';
import { DEFAULT_MODEL, getTokenLimits } from '../models/config.js';

// Create an MCP client
const mcpClient = new MCPClient();

/**
 * Creates message array with either full or summarized content
 */
function createMessages(pageData, useSummarized = false) {
  const {
    pageUrl, deviceType, cms, rulesSummary,
    resources, crux, psi, perfEntries, har,
    cruxSummary, psiSummary, perfEntriesSummary, harSummary
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

  // Perform data collection using the MCP client
  const artifacts = await collectArtifacts(pageUrl, deviceType, options);
  artifacts.pageUrl = pageUrl;
  artifacts.deviceType = deviceType;

  // Check for Cloudflare challenge
  if (Object.values(artifacts.resources).some((url) => url.includes('/cdn-cgi/challenge-platform/'))) {
    return new Error('Cloudflare challenge detected.');
  }

  // Create LLM instance using the factory
  const llm = LLMFactory.createLLM(model, options.llmOptions || {});

  // Invoke LLM and handle retries automatically
  return invokeLLM(llm, artifacts, model, false);
}
