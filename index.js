import dotenv from 'dotenv';
import runAgent from './agent.js';

dotenv.config();

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node index.js <pageUrl> <deviceType=mobile|desktop>');
}

const pageUrl = args[0];
const deviceType = args[1] || 'mobile';

console.log('Generating suggestions for', pageUrl, 'on', deviceType, '...');


const result = await runAgent(pageUrl, deviceType);
console.log(result.messages?.at(-1)?.content || result.content || result);
console.log(result.usage_metadata);
