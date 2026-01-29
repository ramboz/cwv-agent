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
        // URL parsing can fail for:
        // 1. Malformed URLs (e.g., missing protocol, invalid characters)
        // 2. Relative URLs that need a base URL
        // 3. Data URIs or blob URLs
        // These are typically edge cases and can be safely skipped
        console.warn('Skipping resource with invalid URL:', r.url, e.message);
      }
    }
  });

  return results;
}
