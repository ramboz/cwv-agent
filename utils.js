import fs from 'fs';

const OUTPUT_DIR = './.cache';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
}

// A crude approximation of the number of tokens in a string
export function estimateTokenSize(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

// Save some results in the cache on the file system
export function cacheResults(urlString, type, results) {
  ensureDir(OUTPUT_DIR);
  const url = new URL(urlString);
  if (type === 'code') {
    ensureDir(`${OUTPUT_DIR}/${url.hostname}`);
    const filename = url.pathname !== '/'
      ? url.pathname.replace(/\//g, '--').replace(/(^-+|-+$)/, '')
      : 'index.html';
    fs.writeFileSync(`${OUTPUT_DIR}/${url.hostname}/${filename}`, results);
    return;
  }
  fs.writeFileSync(
    `${OUTPUT_DIR}/${urlString.replace('https://', '').replace(/[^A-Za-z0-9-]/g, '-')}.${type}.json`,
    JSON.stringify(results, null, 2),
  );
}