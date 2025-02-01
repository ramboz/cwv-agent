import dotenv from 'dotenv';
import collectArtifacts from './collect.js';
import runAgent from './agent.js';

dotenv.config();

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node index.js <action=collect|analyze> <pageUrl> <deviceType=mobile|desktop>');
}

const action = args[0] || 'collect';
const pageUrl = args[1];
const deviceType = args[2] || 'mobile';

console.log('Generating suggestions for', pageUrl, 'on', deviceType, '...');


if (action === 'analyze') {
  const result = await runAgent(pageUrl, deviceType);
  console.log(result.messages?.at(-1)?.content || result.content || result);
  console.log(result.usage_metadata);  
} else {
  await collectArtifacts(pageUrl, deviceType);
  console.log('Done. Check the `.cache` folder');  
}
