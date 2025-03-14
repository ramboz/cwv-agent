import { getSequence } from './shared.js';

const THRESHOLDS = {
  'text/javascript': 20,
  'text/css': 10,
}

export default function evaluate({ summary, report }) {
  const sequence = getSequence(report);

  const results = [];
  const current = new URL(summary.url).hostname;
  sequence.forEach(r => {
    if (r.entryType === 'resource' && r.url) {
      try {
        const u = new URL(r.url);
        if (u.hostname !== current) {
          results.push({
            category: 'loading-sequence',
            message: `Resource ${r.url} is loaded from a different origin - this costs at least 500ms.`,
            recommendation: `Move the resource to the same origin as the page or defer it after the LCP`,
            passing: false,
            time: r.start,
          });
        }
      } catch (e) {
        // TODO understand why this happens
        console.error('Error parsing URL', r.url, e);
      }
    }
  });

  return results;
}
