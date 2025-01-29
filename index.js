import runAgent from './agent.js';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node index.js <pageUrl> <deviceType=mobile|desktop>');
}

const pageUrl = args[0];
const deviceType = args[1] || 'mobile';

console.log('Generating suggestions for', pageUrl, 'on', deviceType, '...');

const result = await runAgent(pageUrl, deviceType);
console.log(result.messages.at(-1)?.content);  
