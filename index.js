import dotenv from 'dotenv';
import collectArtifacts from './collect.js';
import merge from './tools/merge.js';
import rules from './rules/index.js';
// import runAgent from './agent.js';
import runPrompt from './multishot-prompt.js';
import { cacheResults } from './utils.js';

dotenv.config();

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node index.js <action=collect|analyze> <pageUrl> <deviceType=mobile|desktop>');
}

const action = args[0] || 'collect';
const pageUrl = args[1];
const deviceType = args[2] || 'mobile';

console.log('Generating suggestions for', pageUrl, 'on', deviceType, '...');


if (action === 'agent') {
  // const result = await runAgent(pageUrl, deviceType);
  // console.log(result.messages?.at(-1)?.content || result.content || result);
  // console.log(result.usage_metadata);  
} else if (action === 'prompt') {
  const result = await runPrompt(pageUrl, deviceType);
  cacheResults(pageUrl, deviceType, 'report', result);
  console.log(result.messages?.at(-1)?.content || result.content || result);
  console.log(result.usage_metadata);  
} else if (action === 'collect') {
  const {
    har,
    psi,
    resources,
    perfEntries,
    crux,
  } = await collectArtifacts(pageUrl, deviceType);
  const results = await Promise.all(rules.map((r) => r({}, crux, psi, har, perfEntries, resources)));
  results
    .filter((r) => !r.passing)
    .forEach((r) => console.log('Failed', r.message, ':', r.recommendation));
  console.log('Done. Check the `.cache` folder');  
} else if (action === 'merge') {
  merge(pageUrl, deviceType);
  console.log('Done. Check the `.cache` folder');  
} else {
  console.error('Invalid action:', action);
  process.exit(1);
}
