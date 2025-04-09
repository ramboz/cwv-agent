import { getSequence, getInitiator } from '../shared.js';

const THRESHOLD = 60;

export default function evaluate({ summary, report, har }) {
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
            message: `Third-party resource (from a different origin) detected in critical path (before LCP) causing ${r.duration.toFixed(0)}ms delay`,
            recommendation: `Move the resource to the same origin as the page, defer it after the LCP, or use preloading techniques if it is required for the LCP`,
            url: r.url,
            passing: false,
            time: r.start,
            initiator: getInitiator(har, r.url),
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
