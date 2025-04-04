import { getSequence } from '../shared.js';

export default function evaluate({ report }) {
  const { sequence } = getSequence(report);

  const redirects = sequence.filter(e => e.entryType === 'resource' && e.redirect > 0);
  if (redirects.length > 0) {
    return redirects.map(r => ({
      category: 'critical-path',
      message: `Redirect detected in critical path (before LCP) and causing ${r.redirect}ms delay`,
      recommendation: 'Update the reference and use the final URL in your code to avoid the redirect chain',
      url: r.url,
      passing: false,
      time: r.start,
    }));
  }
}
