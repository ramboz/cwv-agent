import fs from 'fs';

const OUTPUT_DIR = './.cache';

function getFilePrefix(urlString, deviceType, type) {
  return `${OUTPUT_DIR}/${urlString.replace('https://', '').replace(/[^A-Za-z0-9-]/g, '-').replace(/\//g, '--').replace(/(^-+|-+$)/, '')}.${deviceType}.${type}`
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
  if (type === 'code' && fs.existsSync(`${OUTPUT_DIR}/${url.hostname}/${filename}`)) {
    return fs.readFileSync(`${OUTPUT_DIR}/${url.hostname}/${filename}`, { encoding: 'utf8' });
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
    let filename = url.pathname !== '/'
      ? url.pathname.replace(/\//g, '--').replace(/(^-+|-+$)/, '')
      : 'index';
    const [, ext] = filename.split('/').pop().split('.');
    if (!ext) {
      filename += '.html';
    }
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
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export async function getNormalizedUrl(urlString) {
  let normalizedUrl;
  const headers = {
    // PSI mobile user agent
    'User-Agent': 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  };
  // Try a HEAD request first
  let resp = await fetch(urlString, { headers, method: 'HEAD' });
  if (!resp.ok) {
    // If that fails, try a GET request
    resp = await fetch(urlString, { headers });
    if (!resp.ok) {
      throw new Error(`HTTP error! status: ${resp.status}`, resp);
    } else {
      // If the response is a redirect, use the Location header, otherwise use the normalized URL
      normalizedUrl = resp.headers.get('Location') || resp.url;
    }
  } else {
    // If the response is not a redirect, use the normalized URL
    normalizedUrl = resp.url;
  }
  return normalizedUrl;
}