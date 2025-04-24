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
} from '../prompts/index.js';
import { detectAEMVersion } from '../tools/aem.js';
import merge from '../tools/merge.js';
import { applyRules } from '../tools/rules.js';
import { estimateTokenSize, cacheResults, getCachedResults, getCachePath } from '../utils.js';
import { LLMFactory } from '../models/llm-factory.js';
import { DEFAULT_MODEL, getTokenLimits } from '../models/config.js';

export default async function runPrompt(pageUrl, deviceType, options = {}) {
  // Get model from options or use default
  const model = options.model || DEFAULT_MODEL;
  const tokenLimits = getTokenLimits(model);
  
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

  if (Object.values(resources).some((url) => url.includes('/cdn-cgi/challenge-platform/'))) {
    return new Error('Cloudflare challenge detected.');
  }

  // Create LLM instance using the factory
  const llm = LLMFactory.createLLM(model, options.llmOptions || {});

  let messages = [
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

  const enc = new Tiktoken(cl100k_base);
  let tokensLength = messages.map((m) => enc.encode(m.content).length).reduce((a, b) => a + b, 0);
  console.log('Prompt Tokens:', tokensLength);
  if (tokensLength > (tokenLimits.input - tokenLimits.output) * .9) {
    console.log('Context window limit hit. Trying with summarized prompt...');
    messages = [
      new SystemMessage(initializeSystem(cms)),
      new HumanMessage(cruxSummaryStep(cruxSummary)),
      new HumanMessage(psiSummaryStep(psiSummary)),
      new HumanMessage(perfSummaryStep(perfEntriesSummary)),
      new HumanMessage(harSummaryStep(harSummary)),
      new HumanMessage(htmlStep(pageUrl, resources)),
      new HumanMessage(rulesStep(rulesSummary)),
      new HumanMessage(codeStep(pageUrl, resources, 10_000)),
      new HumanMessage(actionPrompt(pageUrl, deviceType)),
    ]
    tokensLength = messages.map((m) => enc.encode(m.content).length).reduce((a, b) => a + b, 0);
    console.log('Prompt Tokens (simplified):', tokensLength);
  }

  try {
    // Direct invocation
    const result = await llm.invoke(messages);
    cacheResults(pageUrl, deviceType, 'report', result, '', model);
    const path = cacheResults(pageUrl, deviceType, 'report', result.content, '', model);
    console.log('✅ CWV report generated at:', path);
    return result;

    // Streaming results
    // const stream = await llm.stream(messages);
    // let response = '';
    // for await (const chunk of stream) {
    //   response += chunk?.lc_kwargs?.content?.toString();
    // }
    // return { content: response };
  } catch (error) {
    console.error('❌ Failed to generate report for', pageUrl);
    if (error.code === 400) { // Token limit reached, try with shorter prompt
      console.log('Context window limit hit, even with summarized prompt.', error);
    }
    else if (error.status === 429) { // Reached rate limit
      console.log('Rate limit hit. Try again in 5 mins...', error);
    } else {
      console.error(error);
    }
    return error;
  }
}
