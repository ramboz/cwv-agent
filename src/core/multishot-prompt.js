import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatVertexAI } from '@langchain/google-vertexai';
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
  htmlStep,
  codeStep,
  rulesStep,
  actionPrompt,
} from '../prompts/index.js';
import { detectAEMVersion } from '../tools/aem.js';
import merge from '../tools/merge.js';
import { applyRules } from '../tools/rules.js';
import { estimateTokenSize } from '../utils.js';

const MAX_TOKENS = {
  'gemini-2.5-pro-exp-03-25': { input: 1_048_576, output: 65_535 },
  'gemini-2.0-pro-exp-02-05': { input: 2_097_152, output: 8_191 },
}

const model = 'gemini-2.5-pro-exp-03-25';
// model: 'gemini-2.0-pro-exp-02-05',

export default async function runPrompt(pageUrl, deviceType, options) {
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

    const cms = detectAEMVersion(har.log.entries[0].headers, resources[pageUrl]);
    console.log('AEM Version:', cms);

    if (Object.values(resources).some((url) => url.includes('/cdn-cgi/challenge-platform/'))) {
      return new Error('Cloudflare challenge detected.');
    }
  
    const llm = new ChatVertexAI({
      model,
      maxOutputTokens: MAX_TOKENS[model].output,
    });
  
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
    if (tokensLength > (MAX_TOKENS[model].input - MAX_TOKENS[model].output) * .9) {
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
      return result;

      // Streaming results
      // const stream = await llm.stream(messages);
      // let response = '';
      // for await (const chunk of stream) {
      //   response += chunk?.lc_kwargs?.content?.toString();
      // }
      // return { content: response };
    } catch (error) {
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
