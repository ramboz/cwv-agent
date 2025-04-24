import fs from 'fs';
import { Agent } from 'undici';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';

const OUTPUT_DIR = './.cache';
let encoder;

function getFilePrefix(urlString, deviceType, type) {
  return `${OUTPUT_DIR}/${urlString.replace('https://', '').replace(/[^A-Za-z0-9-]/g, '-').replace(/\//g, '--').replace(/(^-+|-+$)/, '')}.${deviceType}.${type}`
}

function getFilename(url) {
  let filename = url.pathname !== '/'
    ? url.pathname.replace(/\//g, '--').replace(/(^-+|-+$)/, '')
    : 'index';
  const [, ext] = filename.split('/').pop().split('.');
  if (!ext) {
    filename += '.html';
  }
  return filename;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
}

function modelSuffix(model) {
  if (!model) return '';

  // Extract the model name and major version using regex
  // This matches patterns like 'gemini-2.5', 'gpt-4.1', 'claude-3-7'
  const match = model.match(/^([a-z]+)[-]?(\d+)\.?(\d+)?/);

  if (match) {
    const [, name, majorVer, minorVer] = match;
    return `.${name}${majorVer}${minorVer || ''}`;
  }

  // Fallback for other models
  return `.${model.replace(/[^a-zA-Z0-9]/g, '')}`;
}

// A crude approximation of the number of tokens in a string
export function estimateTokenSize(obj) {
  if (!obj) {
    return 0;
  }
  if (!encoder) {
    encoder = new Tiktoken(cl100k_base);
  }
  return encoder.encode(JSON.stringify(obj)).length;
}

export function getCachedResults(urlString, deviceType, type, suffix = '', model = '') {
  if (type === 'code') {
    const url = new URL(urlString);
    const filename = getFilename(url);
    if (fs.existsSync(`${OUTPUT_DIR}/${url.hostname}/${filename}`)) {
      return fs.readFileSync(`${OUTPUT_DIR}/${url.hostname}/${filename}`, { encoding: 'utf8' });
    }
  } else if (type === 'html' && fs.existsSync(`${getFilePrefix(urlString, deviceType, 'full')}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.html`)) {
    return fs.readFileSync(`${getFilePrefix(urlString, deviceType, 'full')}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.html`, { encoding: 'utf8' });
  } else if (fs.existsSync(`${getFilePrefix(urlString, deviceType, type)}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.json`)) {
    const content = fs.readFileSync(`${getFilePrefix(urlString, deviceType, type)}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.json`, { encoding: 'utf8' });
    return JSON.parse(content);
  }
  return null;
}

/**
 * Returns the path where cache results would be stored without writing to the file
 * @param {string} urlString - The URL of the page
 * @param {string} deviceType - Device type (mobile or desktop)
 * @param {string} type - Type of data (e.g., 'psi', 'crux', 'html', 'code')
 * @param {string} [suffix] - Optional suffix to append to the filename
 * @param {boolean} [isSummary=false] - Whether this is a summary file
 * @param {string} [model=''] - Optional model name to include in the filename
 * @returns {string} The path where the cache would be stored
 */
export function getCachePath(urlString, deviceType, type, suffix = '', isSummary = false, model = '') {
  const url = new URL(urlString);

  if (type === 'code') {
    const filename = getFilename(url);
    return `${OUTPUT_DIR}/${url.hostname}/${filename}`;
  } else if (type === 'html') {
    return `${getFilePrefix(urlString, deviceType, 'full')}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.html`;
  } else if (isSummary) {
    return `${getFilePrefix(urlString, deviceType, type)}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.summary.md`;
  } else {
    return `${getFilePrefix(urlString, deviceType, type)}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.json`;
  }
}

// Save some results in the cache on the file system
export function cacheResults(urlString, deviceType, type, results, suffix = '', model = '') {
  let outputFile = '';
  ensureDir(OUTPUT_DIR);
  const url = new URL(urlString);
  
  if (type === 'code') {
    ensureDir(`${OUTPUT_DIR}/${url.hostname}`);
    const filename = getFilename(url);
    outputFile = `${OUTPUT_DIR}/${url.hostname}/${filename}`;
    fs.writeFileSync(outputFile, results);
  } else if (type === 'html') {
    outputFile = `${getFilePrefix(urlString, deviceType, 'full')}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.html`;
    fs.writeFileSync(
      outputFile,
      results,
    );
  } else if (typeof results === 'string') {
    outputFile = `${getFilePrefix(urlString, deviceType, type)}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.summary.md`;
    fs.writeFileSync(
      outputFile,
      results,
    );
  } else {
    outputFile = `${getFilePrefix(urlString, deviceType, type)}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.json`;
    fs.writeFileSync(
      outputFile,
      typeof results === 'string' ? results : JSON.stringify(results, null, 2),
    );
  }
  return outputFile;
}

export function getSummaryLogger(urlString, deviceType, type) {
  const filePath = `${getFilePrefix(urlString, deviceType, type)}.summary.txt`;
  return fs.createWriteStream(filePath, {
    flags: 'w+'
  });
}

export function readCache(urlString, deviceType, type) {
  const filePath = `${getFilePrefix(urlString, deviceType, type)}.json`;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`Cache file ${filePath} does not exist`);
    return null;
  }
}

function ensureHttps(url) {
  const urlObj = new URL(url);
  urlObj.protocol = 'https';
  return urlObj.toString();
}

// Headers needed to bypass basic bot detection
export const AGENT_HTTP_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'User-Agent': 'Spacecat 1/0'
}

export async function getNormalizedUrl(urlString) {
  // Try a HEAD request first
  let resp
  try {
    resp = await fetch(urlString, { headers: AGENT_HTTP_HEADERS, method: 'HEAD' });
    if (resp.ok) {
      return { url: ensureHttps(resp.url) };
    }
  } catch (err) {
    // Handle TLS errors
    if (err.cause?.code) {
      resp = await fetch(urlString, {
        headers: AGENT_HTTP_HEADERS,
        method: 'HEAD',
        dispatcher: new Agent({
          connect: {
            rejectUnauthorized: false,
          },
        }),
      });
      if (resp.ok) {
        return { url: ensureHttps(resp.url), skipTlsCheck: true };
      }
    }
  }

  // If that fails, try a GET request
  resp = await fetch(urlString, { headers: AGENT_HTTP_HEADERS });
  if (resp.ok) {
    return { url: ensureHttps(resp.headers.get('Location') || resp.url) };
  }

  // Handle redirect chains
  if (urlString !== resp.url) {
    console.log('Redirected to', resp.url);
    return getNormalizedUrl(resp.url);
  }

  throw new Error(`HTTP error! status: ${resp.status}`);
}