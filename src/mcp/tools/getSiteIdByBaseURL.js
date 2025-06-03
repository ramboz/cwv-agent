import dotenv from 'dotenv';
dotenv.config();

import { callMCP } from '../client.js';
import { Buffer } from 'node:buffer';

export async function getSiteIdByBaseURL(baseURL, extraHeaders = {}) {
  if (!baseURL) throw new Error('baseURL is required');

  const baseURLBase64 = Buffer.from(baseURL).toString('base64');
  const uri = `spacecat-data://sites/by-base-url/${baseURLBase64}`;

  const result = await callMCP('resources/read', extraHeaders, { uri });

  if (!result?.contents || result.contents.length === 0) {
    throw new Error(`No site found for baseURL: ${baseURL}`);
  }

  const siteData = JSON.parse(result.contents[0].text);
  return siteData;
}

async function main() {
  try {
    const baseURL = 'https://petplace.com';
    const headers = { 'x-api-key': process.env.MCP_API_KEY };

    const site = await getSiteIdByBaseURL(baseURL, headers);
    console.log('Site ID:', site.siteId);
    console.log('Full Site Resource:', site);
  } catch (err) {
    console.error('Error fetching site ID:', err);
    console.error(err.stack);
  }
}

main();