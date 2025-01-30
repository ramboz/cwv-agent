import psi from 'psi';

export default async function collectPsi(pageUrl, deviceType) {
  console.debug('Generating PageSpeed Insights audit for', pageUrl, 'on', deviceType);
  const psiAudit = await psi(pageUrl, {
    key: process.env.GOOGLE_PAGESPEED_INSIGHTS_API_KEY,
    strategy: deviceType
  });
  console.debug('Done generating PSI audit');
  return psiAudit;
}