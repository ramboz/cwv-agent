import psi from 'psi';

export default async function collectPsi(pageUrl, deviceType) {
  console.debug('Generating PageSpeed Insights audit for', pageUrl, 'on', deviceType);
  const psiAudit = await psi(pageUrl, { strategy: deviceType });
  console.debug('Done generating PSI audit');
  return psiAudit;
}