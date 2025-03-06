import psi from 'psi';
import { cacheResults, getSummaryLogger } from '../utils.js';

const abbreviations = {
  CUMULATIVE_LAYOUT_SHIFT_SCORE: 'CLS',
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: 'TTFB',
  FIRST_CONTENTFUL_PAINT_MS: 'FCP',
  INTERACTION_TO_NEXT_PAINT: 'INP',
  LARGEST_CONTENTFUL_PAINT_MS: 'LCP',
}

function summarizeCWV(psi, log) {
  log('Core Web Vitals:');
  Object.entries(psi.data.loadingExperience.metrics).forEach(([k, v]) => {
    log('-', abbreviations[k], ':', v.category, '(', v.distributions.map((d) => {
      const percentage = `${Math.round(d.proportion * 100)}%`;
      if (d.min & d.max) return `${d.min}-${d.max}: ${percentage}`;
      if (d.min) return `>${d.min}: ${percentage}`;
      if (d.max) return `<${d.max}: ${percentage}`;
      return '';
    }).join(', '), ', 75th percentile', v.percentile, ')');
  });
}

function summarizeLCP(psi, log) {
  log('LCP Element:');
  const lcpImage = psi.data.lighthouseResult.audits['prioritize-lcp-image'].details.debugData.initiatorPath[0].url;
  const lcpRequest = lcpImage ? psi.data.lighthouseResult.audits['network-requests'].details.items.find((i) => i.url === lcpImage) : null;
  if (lcpImage) {
    log('- Image Url:', lcpImage);
  } else {
    log('- HTML Snippet:', psi.data.lighthouseResult.audits['largest-contentful-paint-element'].details.items[0].items[0].node.snippet);
  }
  log('- CSS Selector:', psi.data.lighthouseResult.audits['largest-contentful-paint-element'].details.items[0].items[0].node.selector);
  if (lcpRequest) {
    log('- Mime Type:', lcpRequest.mimeType);
    log('- Priority:', lcpRequest.priority);
    log('- Size:', lcpRequest.transferSize);
  }
  log('- Timings:');
  psi.data.lighthouseResult.audits['largest-contentful-paint-element'].details.items[1].items.forEach((t) => {
    log('    -', t.phase, ':', Math.round(t.timing));
  });
}

function summarizePSIOpportunities(psi, log) {
  log('Top PageSpeed Insights Opportunities:');
  const opportunities = Object.values(psi.data.lighthouseResult.audits)
    .filter((a) => a.score < 1 && a.score !== null);
  opportunities.sort((a, b) => a.score - b.score);
  opportunities.slice(0, 10).forEach((o) => {
    log('-', o.title, ':', o.displayValue || '');
    const items = o.details?.items;
    if (['uses-long-cache-ttl'].includes(o.id)) {
      items?.sort((a, b) => b.wastedBytes - a.wastedBytes);
    }
    items?.slice && items.slice(0, 10).forEach((i) => {
      const label = (i.url && i.url.replace(/\?.*/, '')) || i.entity || i.node?.selector || i.groupLabel || i;
      const value = Math.round(i.total || i.score || i.blockingTime || i.duration || i.wastedBytes || i.totalBytes || 0);
      if (value) {
        log('    -', label, ':', value);
      }
    });
  });
}

export default async function collectPsi(pageUrl, deviceType) {
  console.debug('Generating PageSpeed Insights audit for', pageUrl, 'on', deviceType);
  const psiAudit = await psi(pageUrl, {
    key: process.env.GOOGLE_PAGESPEED_INSIGHTS_API_KEY,
    strategy: deviceType
  });

  cacheResults(pageUrl, deviceType, 'psi', psiAudit);

  // Summarize
  const logger = getSummaryLogger(pageUrl, deviceType, 'psi');
  summarizeCWV(psiAudit, (...str) => logger.write(str.join(' ') + '\n'));
  logger.write('\n');
  summarizeLCP(psiAudit, (...str) => logger.write(str.join(' ') + '\n'));
  logger.write('\n');
  summarizePSIOpportunities(psiAudit, (...str) => logger.write(str.join(' ') + '\n'));
  logger.end();

  console.debug('Done generating PSI audit');
  return psiAudit;
}