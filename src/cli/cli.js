import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { DEFAULT_MODEL } from '../models/config.js';

export function parseArguments() {
  return yargs(hideBin(process.argv))
    .option('action', {
      alias: 'a',
      describe: 'Action to perform',
      type: 'string',
      default: 'collect',
      choices: ['collect', 'prompt', 'merge', 'agent', 'rules']
    })
    .option('url', {
      alias: 'u',
      describe: 'URL to analyze',
      type: 'string'
    })
    .option('urls', {
      describe: 'Path to JSON file containing URLs to analyze',
      type: 'string'
    })
    .option('device', {
      alias: 'd',
      describe: 'Device type',
      type: 'string',
      default: 'mobile',
      choices: ['mobile', 'desktop']
    })
    .option('skip-cache', {
      alias: 's',
      describe: 'Skip using cached data and force new collection',
      type: 'boolean',
      default: false
    })
    .option('model', {
      alias: 'm',
      describe: 'LLM model to use (e.g., "gemini-2.5-pro-preview-05-06", "gpt-4o")',
      type: 'string',
      default: DEFAULT_MODEL
    })
    .option('output-suffix', {
      alias: 'o',
      describe: 'Suffix for output recommendations file',
      type: 'string',
      default: ''
    })
    .option('block-requests', {
      alias: 'b',
      describe: 'Block requests - comma separated list of strings, urls containing these strings will be blocked',
      type: 'string',
      default: ''
    })
    .check((argv) => {
      if (!argv.url && !argv.urls) {
        throw new Error('Either --url or --urls must be provided');
      }
      return true;
    })
    .help()
    .argv;
} 