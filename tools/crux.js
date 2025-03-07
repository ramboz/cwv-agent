import { cacheResults, getCachedResults } from '../utils.js';

export default async function collectCrux(pageUrl, deviceType) {
  const cache = getCachedResults(pageUrl, deviceType, 'crux');
  if (cache) {
    return cache;
  }

  const resp = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${process.env.GOOGLE_CRUX_API_KEY}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: pageUrl,
      formFactor: deviceType === 'mobile' ? 'PHONE' : 'DESKTOP',
    }),
  });

  const json = await resp.json();
  cacheResults(pageUrl, deviceType, 'crux', json);
  return json;
}
