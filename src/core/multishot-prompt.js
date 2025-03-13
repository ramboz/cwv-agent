import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatVertexAI } from '@langchain/google-vertexai';
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
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
  actionPrompt,
} from '../prompts.js';
import { detectAEMVersion } from '../tools/aem.js';
import { estimateTokenSize } from '../utils.js';

export default async function runPrompt(pageUrl, deviceType, skipCache) {
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
      mainHeaders,
    } = await collectArtifacts(pageUrl, deviceType, skipCache);

    const cms = detectAEMVersion(mainHeaders, resources[pageUrl]);
    console.log('AEM Version:', cms);
  
    // Perform data collection before running to model, so we don't waste calls if an error occurs
    const llm = new ChatVertexAI({
      model: 'gemini-2.0-pro-exp-02-05',
      maxOutputTokens: 8192,
    });
  
    let messages = [
      new SystemMessage(initializeSystem(cms)),
      new HumanMessage(cruxStep(1, crux)),
      new HumanMessage(psiStep(2, psi)),
      new HumanMessage(harStep(3, har)),
      // new HumanMessage(perfStep(4, perfEntries)),
      new HumanMessage(htmlStep(4, pageUrl, resources)),
      new HumanMessage(codeStep(5, pageUrl, resources)),
      new HumanMessage(actionPrompt(pageUrl, deviceType)),
    ];

    const enc = new Tiktoken(cl100k_base);
    let tokensLength = messages.map((m) => enc.encode(m.content).length).reduce((a, b) => a + b, 0);
    console.log('Prompt Tokens:', tokensLength);
    if (tokensLength > 0.9 * 2_000_000) {
      console.log('Context window limit hit. Trying with summarized prompt...');
      messages = [
        new SystemMessage(initializeSystem(cms)),
        new HumanMessage(cruxSummaryStep(1, cruxSummary)),
        new HumanMessage(psiSummaryStep(2, psiSummary)),
        new HumanMessage(harSummaryStep(3, harSummary)),
        // new HumanMessage(perfSummaryStep(4, perfEntriesSummary)),
        new HumanMessage(htmlStep(4, pageUrl, resources)),
        new HumanMessage(codeStep(5, pageUrl, resources, 50_000)),
        new HumanMessage(actionPrompt(pageUrl, deviceType)),
      ]
      tokensLength = messages.map((m) => enc.encode(m.content).length).reduce((a, b) => a + b, 0);
      console.log('Prompt Tokens (simplified):', tokensLength);
    }

    try {
      const result = await llm.invoke(messages);
      return result;
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
