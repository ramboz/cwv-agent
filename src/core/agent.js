import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { readFile } from 'fs/promises'
import dotenv from 'dotenv';
import { z } from "zod";
import { initializeSystem } from '../prompts/index.js';

dotenv.config();

const llm = new ChatVertexAI({
  model: "gemini-2.5-pro-preview-05-06",
  // model: "gemini-2.0-pro-exp-02-05",
  temperature: 0
});

const tools = {
  psi: tool(
    async ({ url }) => {
      console.log('PSI CALLED', url);
      const summary = await readFile('./.cache/www-wilson-com-en-us-golf.mobile.psi.summary.txt', { encoding: 'utf8' });
      return summary;
    },
    {
      name: 'psi',
      schema: z.object({
        url: z.string(),
      }),
      description: 'Provides a summary of the Google PageSpeed Insights report',
    }
  ),
  har: tool(
    async ({ url }) => {
      console.log('HAR CALLED', url);
      const summary = await readFile('./.cache/www-wilson-com-en-us-golf.mobile.har.summary.txt', { encoding: 'utf8' });
      return summary;
    },
    {
      name: 'har',
      schema: z.object({
        url: z.string(),
      }),
      description: 'Provides additional markup for the page based on an HAR file',
    }
  ),
  code: tool(
    async ({ path }) => {
      console.log('CODE CALLED', path);
      let file = path.replace(/\//g, '--').replace(/(^-+|-+$)/, '');
      const code = await readFile(`./.cache/www.wilson.com/${file}`, { encoding: 'utf8' });
      return code;
    },
    {
      name: 'code',
      schema: z.object({
        path: z.string(),
      }),
      description: 'Provides the source code for a given file path',
    }
  ),
}

const llmWithTools = llm.bindTools(Object.values(tools));

const messages = [new SystemMessage(initializeSystem)];

async function runPhase(messages, msg) {
  messages.push(msg);
  let aiMessage = await llmWithTools.invoke(messages);
  messages.push(aiMessage);
  while (aiMessage.tool_calls.length) {
    for (const toolCall of aiMessage.tool_calls) {
      const selectedTool = tools[toolCall.name];
      const toolMessage = await selectedTool.invoke(toolCall);
      messages.push(toolMessage);
    }
    aiMessage = await llmWithTools.invoke(messages);
    messages.push(aiMessage);
  }
  return aiMessage;
}

const phase1 = await runPhase(messages, new HumanMessage("You will analyze URL https://www.wilson.com/en-us/golf, and focus on phase 1 with the PSI summary."));
console.log('Phase 1', phase1.content);
const phase2 = await runPhase(messages, new HumanMessage("You will now move to phase 2 and review your findings with the page markup provided by the HAR tool."));
console.log('Phase 2', phase2.content);
const phase3 = await runPhase(messages, new HumanMessage("You will now move to phase 3 and review your findings from phase 2 with the source code of the main files in the page: /scripts/scripts.js, /styles/styles.css, /styles/styles-wilson/fonts.css, /scripts/delayed.js, /scripts/aem.js, /blocks/hero/hero.js, /blocks/columns/columns.js"));
console.log('Phase 3', phase3.content);
const phase4 = await runPhase(messages, new HumanMessage("You will now deliver your comprehensive analysis based on the previous phases, in the format that was initially defined."));
console.log('Report', phase4.content);

// import { HumanMessage, SystemMessage } from '@langchain/core/messages';
// import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
// import collectArtifacts from './collect.js';
// import {
//   initializeSystem, includeCode, includeHAR, includePSI, actionPrompt,
// } from './prompts.js';

export default async function runAgent(pageUrl, deviceType) {
//   const {
//     har,
//     psi,
//     requests,
//   } = await collectArtifacts(pageUrl, deviceType);

//   // Perform data collection before running to model, so we don't waste calls if an error occurs
//   const llm =  new ChatGoogleGenerativeAI({
//     modelName: 'gemini-1.5-pro',
//     // modelName: 'gemini-2.0-flash',
//     // modelName: 'gemini-2.0-flash-thinking-exp',
//     apiKey: process.env.GOOGLE_GEMINI_API_KEY,
//   });

//   const result = await llm.invoke([
//     new SystemMessage(initializeSystem),
//     new HumanMessage(includeHAR(har)),
//     new HumanMessage(includePSI(psi)),
//     new HumanMessage(includeCode(requests)),
//     new HumanMessage(actionPrompt(pageUrl, deviceType)),
//   ]);
//   return result;
}
