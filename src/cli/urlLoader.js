import fs from 'fs';
import path from 'path';

export function loadUrls(argv) {
  let urls = [];

  if (argv.url) {
    urls = [argv.url];
  } else if (argv.urls) {
    try {
      const urlsFilePath = path.resolve(argv.urls);
      const urlsData = JSON.parse(fs.readFileSync(urlsFilePath, 'utf8'));
      if (Array.isArray(urlsData)) {
        urls = urlsData;
      } else {
        console.error('URLs file must contain a JSON array of URLs');
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error reading URLs file: ${error.message}`);
      process.exit(1);
    }
  }

  return urls;
} 