import { getSequence, getInitiator } from '../shared.js';

const THRESHOLDS = {
  'text/javascript': 20,
  'application/javascript': 20,
  'text/css': 10,
};

export default function evaluate({ report, har }) {
  const { sequence } = getSequence(report);

  const results = [];
  sequence.forEach(r => {
    if (r.entryType === 'resource') {
      if (r.size > THRESHOLDS[r.mimeType]) {
        results.push({
          category: 'size',
          message: `Large resource of ${r.size}kb loaded in critical path (before LCP)`,
          recommendation: `Keep only what is needed to render the LCP and defer the rest, or defer the resource altogether if you can`,
          url: r.url,
          passing: false,
          time: r.start,
          initiator: getInitiator(har, r.url),
        });
      }
    }
  });

  return results;
}
