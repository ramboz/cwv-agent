import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import collectHar from './tools/har.js';
import collectPsi from './tools/psi.js';
import { estimateTokenSize } from './utils.js';

export default async function runAgent(pageUrl, deviceType) {

  // Perform data collection before running to model, so we don't waste calls if an error occurs
  const { requests, har } = await collectHar(pageUrl, deviceType);
  console.log('Code token size: ~', estimateTokenSize(requests));
  console.log('HAR token size: ~', estimateTokenSize(har));
  const psiAudit = await collectPsi(pageUrl, deviceType);
  console.log('PSI token size: ~', estimateTokenSize(psiAudit));

  const llm =  new ChatGoogleGenerativeAI({
    // modelName: 'gemini-1.5-pro',
    modelName: 'gemini-2.0-flash-thinking-exp-01-21',
    apiKey: process.env.GOOGLE_GEMINI_API_KEY,
  });

  const initializationMessage = new SystemMessage(`
    You are an expert front-end developer with years of experience optimizing for performance and
    best core web vitals. In particular, you are an expert on AEMaaCS and the newer AEM EDS which
    only serves static files from the CDN and runs without a backend.
  
    You know how to distinguish AEMaaCS from AEM EDS:
    - AEMaaCS: it typically has references to "clientlibs" in the frontend code. It is based on a
      Java stack, with AEM components written using the HTL templating language, and uses
      clientside libraries written in JavaScript for the frontend. The files are usually minified
    - AEM EDS: it typically has references either "aem.js" or "lib-franklin.js" in the frontend code,
      and also has "data-block-status" data attributes. It is based on purely static files served
      by the CDN. The code is usually written in vanilla JavaScript for the frontend. The files are
      usually not minified. Additionally:
      - You also know that on AEM EDS, the CDN cache headers for the first-party domain are
        properly optimized already
      - All images starting with "media_" are already minified and served from the CDN
      - "aem.js" and "lib-franklin.js" is the rendering engine library and should not be touched,
        and cannot be deferred
      - "scripts.js" is responsible for the page rendering and is composed of 3 phases "loadEager"
        (which handles the LCP), "loadLazy" which renders the rest of the page, and "loadDelayed"
        (which loads additional resources that do not directly impact the user experience). This
        file also needs to be executed as early as possible
  
    You pride yourself on precision, thorough code analysis, and detailed optimization proposals.
    You always stick to the concrete factual performance optimizations you can directly tie to
    saved milliseconds on the page load, and you never make up facts or offer just plain generic
    suggestions people could just browse online. Your recommendations are concise and accompanied
    by clear code snippets that a developer can easily integrate.
  
    For your analysis, you rely on the following artifacts that are gathered during the page load:
    - a HAR file
    - a PageSpeed Insights report
    - the source code for the page, the main JavaScript and CSS files being used on the page
    Those artifacts will be provided to you next.
  `);

  const harMessage = new HumanMessage(`
    The HAR JSON object for the page load is as follows:
    ${JSON.stringify(har, null, 2)}
  `);

  const psiMessage = new HumanMessage(`
    The PSI audit JSON object for the page load is as follows:
    ${JSON.stringify(psiAudit, null, 2)}
  `);

  const codeMessage = new HumanMessage(`
    And here are the source codes for the important files on the page (the name for each file is given to you as a comment before its content):
    ${Object.entries(requests).map(([key, value]) => `// File: ${key}\n${value}\n\n`).join('\n')}
  `);

  const promptMessage = new HumanMessage(`
    With all the files that were shared with you, you will perform your performance analysis for the url ${pageUrl} on a ${deviceType} device.
    You will provide a response that:
    - lists the suggestions you have to improve the performance
    - include the problem observed
    - include the CWV metric it applies to
    - include the estimated gain in milliseconds
    - include clear code snippets that a developer can easily integrate
  `);

  const result = await llm.invoke([
    initializationMessage,
    harMessage,
    psiMessage,
    codeMessage,
    promptMessage,
  ]);
  return result;
}
