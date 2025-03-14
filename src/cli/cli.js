import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

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
    .check((argv) => {
      if (!argv.url && !argv.urls) {
        throw new Error('Either --url or --urls must be provided');
      }
      return true;
    })
    .help()
    .argv;
} 