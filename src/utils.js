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
  const match = model.match(/^([a-z]+)[-]?(\d+)\.?(\d+)?[-]?([a-z]+)?/);

  if (match) {
    const [, name, majorVer, minorVer, variant] = match;
    return `.${name}${majorVer}${minorVer || ''}${variant || ''}`;
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
  // Handle code files
  if (type === 'code') {
    const url = new URL(urlString);
    const filename = getFilename(url);
    const filePath = `${OUTPUT_DIR}/${url.hostname}/${filename}`;
    
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, { encoding: 'utf8' });
    }
    return null;
  }
  
  // Handle HTML files
  if (type === 'html') {
    const filePath = `${getFilePrefix(urlString, deviceType, 'full')}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.html`;
    
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, { encoding: 'utf8' });
    }
    return null;
  }
  
  // Handle JSON files (default case)
  const filePath = `${getFilePrefix(urlString, deviceType, type)}${suffix ? `.${suffix}` : ''}${modelSuffix(model)}.json`;
  
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, { encoding: 'utf8' });
    return JSON.parse(content);
  }
  
  return null;
}

/**
 * Builds a path with optional suffix and model info
 * @param {string} basePrefix - Base prefix for the path
 * @param {string} suffix - Optional suffix to append
 * @param {string} model - Optional model name
 * @param {string} extension - File extension
 * @returns {string} - Constructed file path
 */
function buildPath(basePrefix, suffix = '', model = '', extension) {
  const suffixPart = suffix ? `.${suffix}` : '';
  const modelPart = modelSuffix(model);
  return `${basePrefix}${suffixPart}${modelPart}.${extension}`;
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
  // Special case for code files
  if (type === 'code') {
    const url = new URL(urlString);
    const filename = getFilename(url);
    return `${OUTPUT_DIR}/${url.hostname}/${filename}`;
  }
  
  // Handle HTML files
  if (type === 'html') {
    return buildPath(getFilePrefix(urlString, deviceType, 'full'), suffix, model, 'html');
  }
  
  // Handle summary files
  if (isSummary) {
    return buildPath(getFilePrefix(urlString, deviceType, type), suffix, model, 'summary.md');
  }
  
  // Default: JSON files
  return buildPath(getFilePrefix(urlString, deviceType, type), suffix, model, 'json');
}

// Save some results in the cache on the file system
export function cacheResults(urlString, deviceType, type, results, suffix = '', model = '') {
  ensureDir(OUTPUT_DIR);
  
  // Get the appropriate file path based on type
  let outputFile = getCachePath(urlString, deviceType, type, suffix, typeof results === 'string' && type !== 'html', model);
  
  // For code files we need to ensure the parent directory exists
  if (type === 'code') {
    const url = new URL(urlString);
    ensureDir(`${OUTPUT_DIR}/${url.hostname}`);
  }
  
  // Write the content appropriately based on type
  if (type === 'json' || (typeof results !== 'string' && type !== 'html' && type !== 'code')) {
    fs.writeFileSync(
      outputFile,
      typeof results === 'string' ? results : JSON.stringify(results, null, 2)
    );
  } else {
    fs.writeFileSync(outputFile, results);
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

// Standard User Agents for different scenarios
export const USER_AGENTS = {
  psi: {
    desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Spacecat/1.0',
    mobile: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 Spacecat/1.0'    
  }
};

/**
 * Gets HTTP headers with appropriate user agent for the request type
 * @param {string} deviceType - 'desktop' or 'mobile'
 * @returns {Object} - HTTP headers object
 */
export function getRequestHeaders(deviceType) {
  return {
    'Accept': 'text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://www.adobe.com/',
    'User-Agent': USER_AGENTS.psi[deviceType],
  };
}

export async function getNormalizedUrl(urlString, deviceType) {
  const headers = getRequestHeaders(deviceType);
  let resp;
  
  // Try a HEAD request first
  try {
    resp = await fetch(urlString, { headers, method: 'HEAD' });
    if (resp.ok) {
      return { url: ensureHttps(resp.url) };
    }
  } catch (err) {
    // Handle TLS errors
    if (err.cause?.code) {
      try {
        resp = await fetch(urlString, {
          headers,
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
      } catch (tlsErr) {
        console.warn('TLS bypass request failed:', tlsErr.message);
        // Continue to GET request
      }
    }
  }

  // If HEAD fails, try a GET request
  try {
    resp = await fetch(urlString, { headers });
    
    if (resp.ok) {
      return { url: ensureHttps(resp.headers.get('Location') || resp.url) };
    }
    
    // Handle redirect chains
    if (urlString !== resp.url) {
      console.log('Redirected to', resp.url);
      return getNormalizedUrl(resp.url, deviceType);
    }
    
    throw new Error(`HTTP error! status: ${resp.status}`);
  } catch (getErr) {
    throw new Error(`Failed to retrieve URL (${urlString}): ${getErr.message}`);
  }
}