import { tool } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import collectHar from "./tools/har.js";
import collectPsi from "./tools/psi.js";

export default async function runAgent(pageUrl, deviceType) {
  const { requests, har } = await collectHar(pageUrl, deviceType);

  // Define the tools for the agent to use
  const getHar = tool(async () => {
    return har;
  }, {
    name: "get_har",
    description:
      "Use this to fetch the HTTP Archive (HAR) file for the page load.",
  });

  const getPsi = tool(async ({ pageUrl, deviceType }) => {
    const psiAudit = await collectPsi(pageUrl, deviceType);
    psiAuditDone(psiAudit);
    return psiAudit;
  }, {
    name: "get_psi",
    description:
        "Use this to fetch the PageSpeed Insights audit file for the page load. Input is an object: { pageUrl: string, deviceType: string }.",
    schema: z.object({
      pageUrl: z.string().describe("The url for the page that we want to improve the performance on."),
      deviceType: z.string().describe("The device type that is used for that page load (one of mobile, desktop)."),
    }),
  });

  const getCode = tool(async () => {
    return requests;
  }, {
    name: "get_code",
    description:
        "Use this to fetch a map of all relevant files on the site. The key in the map is the file url and the value is the file content.",
  });

  const tools = [getHar, getPsi, getCode];
  const model =  new ChatGoogleGenerativeAI({
    modelName: "gemini-1.5-pro",
    // maxOutputTokens: 4096,
    apiKey: '<your api key>', // TODO: replace with your own
  });

  // Initialize memory to persist state between graph runs
  const checkpointer = new MemorySaver();

  const app = createReactAgent({
    llm: model,
    tools,
    checkpointSaver: checkpointer,
  });

  // Use the agent
  const result = await app.invoke(
    {
      messages: [
        {
          role: 'system',
          content: `
  You are an expert front-end developer with years of experience optimizing for performance and best core web vitals.
  In particular, you are an expert on AEMaaCS and the newer AEM EDS which only serves static files from the CDN and runs without a backend.

  You know how to distinguish AEMaaCS from AEM EDS:
  - AEMaaCS: it typically has references to "/libs/" and "clientlibs" in the frontend code. It is based on a Java stack, with AEM components written using the HTL templating language, and uses clientside libraries written in JavaScript for the frontend. The files are usually minified
  - AEM EDS: it typically has references to "aem.js" or "lib-franklin.js" in the frontend code. It is based on purely static files served by the CDN. The code is usually written in vanilla JavaScript for the frontend. The files are usually not minified.
    - You also know that on AEM EDS, the CDN cache headers for the first-party domain are properly optimized already
    - All images starting with "media_" are webp images
    - "aem.js" and "lib-franklin.js" is the rendering engine library and should not be touched, and cannot be deferred
    - "scripts.js" is responsible for the page rendering and needs to be executed as early as possible

  You pride yourself on incredible precision, thorough code analysis, and detailed optimization proposals.
  You always stick to the concrete factual performance optimizations you can directly tie to saved milliseconds on the page load,
  and you never make up facts or offer just plain generic suggestions people could just browse online.
  Your recommendations are accompanied by clear code snippets that a developer can easily integrate.

  For your analysis, you rely on the following artifacts that are gathered during the page load:
  - a HAR file, that you obtain by calling "get_har"
  - a PageSpeed Insights report, that you obtain by calling "get_psi"
  - the source code for the page, the main JavaScript and CSS files being used on the page, that you obtain by calling "get_code"
  You should not call any these tools more than once.
          `,
        },
        {
          role: "user",
          content: `
  With all the files that were shared with you, you will perform your performance analysis for the url ${pageUrl} on a ${deviceType} device.
  You will provide a response that:
  - lists the suggestions you have to improve the performance
  - include the problem observed
  - include the CWV metric it applies to
  - include the estimated gain in milliseconds
  - include clear code snippets that a developer can easily integrate
          `,
      }]
    },
    { configurable: { thread_id: `url:${pageUrl}-device:${deviceType}` } }
  );
  return result;
}
