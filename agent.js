import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import collectArtifacts from './collect.js';
import {
  initializeSystem, includeCode, includeHAR, includePSI, actionPrompt,
} from './prompts.js';

export default async function runAgent(pageUrl, deviceType) {
  const {
    har,
    psi,
    requests,
  } = await collectArtifacts(pageUrl, deviceType);

  // Perform data collection before running to model, so we don't waste calls if an error occurs
  const llm =  new ChatGoogleGenerativeAI({
    modelName: 'gemini-1.5-pro',
    // modelName: 'gemini-2.0-flash',
    // modelName: 'gemini-2.0-flash-thinking-exp',
    apiKey: process.env.GOOGLE_GEMINI_API_KEY,
  });

  const result = await llm.invoke([
    new SystemMessage(initializeSystem),
    new HumanMessage(includeHAR(har)),
    new HumanMessage(includePSI(psi)),
    new HumanMessage(includeCode(requests)),
    new HumanMessage(actionPrompt(pageUrl, deviceType)),
  ]);
  return result;
}
