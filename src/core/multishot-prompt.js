import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import collectArtifacts from './collect.js';
import {
  initializeSystem,
  cruxStep,
  psiStep,
  harStep,
  perfStep,
  htmlStep,
  codeStep,
  actionPrompt,
} from '../prompts.js';
import { detectAEMVersion } from '../tools/aem.js';

export default async function runAgent(pageUrl, deviceType) {
    const {
      har,
      psi,
      resources,
      crux,
      perfEntries,
    } = await collectArtifacts(pageUrl, deviceType);

    const cms = detectAEMVersion(resources[pageUrl]);
    console.log('AEM Version:', cms);
  
    // Perform data collection before running to model, so we don't waste calls if an error occurs
    const llm =  new ChatGoogleGenerativeAI({
      modelName: 'gemini-2.0-pro-exp-02-05',
      // modelName: 'gemini-2.0-flash',
      // modelName: 'gemini-2.0-flash-thinking-exp',
      apiKey: process.env.GOOGLE_GEMINI_API_KEY,
    });
  
    const result = await llm.invoke([
      new SystemMessage(initializeSystem(cms)),
      new HumanMessage(cruxStep(1, crux)),
      new HumanMessage(psiStep(2, psi)),
      new HumanMessage(harStep(3, har)),
      // new HumanMessage(perfStep(4, perfEntries)),
      new HumanMessage(htmlStep(4, pageUrl, resources)),
      new HumanMessage(codeStep(5, pageUrl, resources)),
      new HumanMessage(actionPrompt(pageUrl, deviceType)),
    ]);
    return result;
  }
  