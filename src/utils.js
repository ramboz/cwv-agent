import fs from 'fs';
import { Agent } from 'undici';

const OUTPUT_DIR = './.cache';

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

// A crude approximation of the number of tokens in a string
export function estimateTokenSize(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

export function getCachedResults(urlString, deviceType, type) {
  if (type === 'code') {
    const url = new URL(urlString);
    const filename = getFilename(url);
    if (fs.existsSync(`${OUTPUT_DIR}/${url.hostname}/${filename}`)) {
      return fs.readFileSync(`${OUTPUT_DIR}/${url.hostname}/${filename}`, { encoding: 'utf8' });
    }
  }
  else if (fs.existsSync(`${getFilePrefix(urlString, deviceType, type)}.json`)) {
    const content = fs.readFileSync(`${getFilePrefix(urlString, deviceType, type)}.json`, { encoding: 'utf8' });
    return JSON.parse(content);
  }
  return null;
}

// Save some results in the cache on the file system
export function cacheResults(urlString, deviceType, type, results) {
  ensureDir(OUTPUT_DIR);
  const url = new URL(urlString);
  if (type === 'code') {
    ensureDir(`${OUTPUT_DIR}/${url.hostname}`);
    const filename = getFilename(url);
    fs.writeFileSync(`${OUTPUT_DIR}/${url.hostname}/${filename}`, results);
    return;
  } else if (typeof results === 'string') {
    fs.writeFileSync(
      `${getFilePrefix(urlString, deviceType, type)}.summary.md`,
      results,
    );
  } else {
    fs.writeFileSync(
      `${getFilePrefix(urlString, deviceType, type)}.json`,
      typeof results === 'string' ? results : JSON.stringify(results, null, 2),
    );
  }
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