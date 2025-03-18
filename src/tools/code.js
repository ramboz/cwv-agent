import { cacheResults, getCachedResults } from '../utils.js';

export async function collect(pageUrl, deviceType, resources, { skipCache, skipTlsCheck }) {
  const { hostname, pathname } = new URL(pageUrl);
  const codeFiles = {};
  let all = 0;
  let cached = 0;
  resources.forEach(async (url) => {
    const request_url = new URL(url);
    if (request_url.hostname === hostname
      && (request_url.pathname === pathname
        || request_url.pathname.endsWith('.html')
        || (request_url.pathname.endsWith('.js')
          && (request_url.pathname.startsWith('/etc.clientlibs/') || !request_url.pathname.endsWith('.min.js')))
        || (request_url.pathname.endsWith('.css')
          && (request_url.pathname.includes('/etc.clientlibs/') || !request_url.pathname.endsWith('.min.css'))))) {
      all++;
      const cache = getCachedResults(url, deviceType, 'code');
      if (cache && !skipCache) {
        cached++;
        codeFiles[url] = cache;
        return;
      }
      const resp = await fetch(request_url.href, {
        // headers to bypass basic bot blocks
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.5',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'User-Agent': 'Spacecat 1/0'
        },
        dispatcher: skipTlsCheck ? new Agent({
          connect: {
            rejectUnauthorized: false,
          },
        }) : undefined,
      });
      const body = await resp.text();
      codeFiles[request_url.href] = body;
      cacheResults(url, deviceType, 'code', body);
    }
  });
  return { codeFiles, fromCache: cached };
}