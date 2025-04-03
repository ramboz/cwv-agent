import { getSequence } from '../shared.js';

export default function evaluate({ report }) {
  const { sequence } = getSequence(report);

  const redirects = sequence.filter(e => e.entryType === 'resource' && e.redirect > 0);
  if (redirects.length > 0) {
    return redirects.map(r => ({
      category: 'critical-path',
      message: `${r.redirect}ms redirect time on the critical path`,
      recommendation: 'Redirects on the critical path are not allowed',
      url: r.url,
      passing: false,
      time: r.start,
    }));
  }
}
