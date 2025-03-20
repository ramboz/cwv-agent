import { getSequence } from './shared.js';

const THRESHOLDS = {
  'text/javascript': 20,
  'application/javascript': 20,
  'text/css': 10,
};

export default function evaluate({ report }) {
  const { sequence } = getSequence(report);

  const results = [];
  sequence.forEach(r => {
    if (r.entryType === 'resource') {
      if (r.size > THRESHOLDS[r.mimeType]) {
        results.push({
          category: 'loading-sequence',
          message: `Resource is large - do you really need those ${r.size} KB before LCP ?`,
          recommendation: `Reduce the size of the resource: keep only what is needed to show the LCP and defer the rest`,
          url: r.url,
          passing: false,
          time: r.start,
        });
      }
    }
  });

  return results;
}
