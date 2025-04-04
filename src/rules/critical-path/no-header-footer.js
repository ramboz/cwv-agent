import { getSequence } from '../shared.js';

export default function evaluate({ report }) {
  const { sequence, lcp } = getSequence(report);

  if (!lcp || !lcp.url) {
    return null;
  }
  const headerIndex = sequence.findIndex((e) => e.entryType === 'resource' && e.url.includes('header.js'));
  const footerIndex = sequence.findIndex((e) => e.entryType === 'resource' && e.url.includes('footer.js'));
  
  const results = [];
  if (headerIndex > -1) {
    const header = sequence[headerIndex];
    results.push({  
      category: 'critical-path',
      message: 'Header detected in critical path (before LCP)',
      recommendation: 'Ensure the page header is lazy loaded after the LCP',
      passing: false,
      time: header.start,
      url: header.url
    });
  }
  if (footerIndex > -1 ) {
    const footer = sequence[footerIndex];
    results.push({
      category: 'critical-path',
      message: 'Footer detected in critical path (before LCP)',
      recommendation: 'Ensure the page footer is lazy loaded after the LCP',
      passing: false,
      time: footer.start,
      url: footer.url
    });
  }
  if (headerIndex > -1 && footerIndex > -1 && headerIndex > footerIndex) {
    const header = sequence[headerIndex];
    results.push({
      category: 'critical-path',
      message: 'Footer detected before the header',
      recommendation: 'Ensure the page header loads before the page footer',
      passing: false,
      time: header.start,
      url: header.url
    });
  }
  return results;
}
