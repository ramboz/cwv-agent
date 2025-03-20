import { getSequence } from './shared.js';

export default function evaluate({ report }) {
  const { sequence, lcp } = getSequence(report);

  const medias = sequence.filter(r => 
    r.entryType === 'resource' &&
    r.url !== lcp.url &&
    (r.mimeType.includes('image') || r.mimeType.includes('video'))
  );
  const results = [];
  medias.forEach(m => {
    results.push({
        category: 'loading-sequence',
        message: `Media file detected in loading sequence (before LCP)`,
        recommendation: `Lazy load media files after the LCP`,
        url: m.url,
        passing: false,
        time: m.start
    });
  });
  return results;
}
