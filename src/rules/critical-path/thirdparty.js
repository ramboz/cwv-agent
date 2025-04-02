import { getSequence } from '../shared.js';

const THRESHOLD = 60;

export default function evaluate({ summary, report }) {
  const { sequence } = getSequence(report);

  const results = [];
  const current = new URL(summary.url).hostname;
  sequence.forEach(r => {
    if (r.entryType === 'resource' && r.url && r.duration > THRESHOLD) {
      try {
        const u = new URL(r.url);
        if (u.hostname !== current) {
          results.push({
            category: 'critical-path',
            message: `Resource is loaded from a different origin - current duration: ${r.duration.toFixed(0)}ms`,
            recommendation: `Move the resource to the same origin as the page or defer it after the LCP`,
            url: r.url,
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
