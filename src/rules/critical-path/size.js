import { getSequence, getInitiator } from '../shared.js';
import { CRITICAL_PATH_THRESHOLDS } from '../../config/thresholds.js';

const THRESHOLDS = {
  'text/javascript': CRITICAL_PATH_THRESHOLDS.RESOURCE_SIZE.javascript / 1024, // Convert bytes to KB
  'application/javascript': CRITICAL_PATH_THRESHOLDS.RESOURCE_SIZE.javascript / 1024,
  'text/css': CRITICAL_PATH_THRESHOLDS.RESOURCE_SIZE.css / 1024,
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
