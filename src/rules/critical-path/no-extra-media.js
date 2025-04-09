import { getSequence, getInitiator } from '../shared.js';

export default function evaluate({ report, har }) {
  const { sequence, lcp } = getSequence(report);

  if (!lcp) {
    return null;
  }
  const medias = sequence.filter(r => 
    r.entryType === 'resource' &&
    r.url !== lcp.url &&
    (r.mimeType.includes('image') || r.mimeType.includes('video')) &&
    !r.url.includes('favicon.ico')
  );
  const results = [];
  medias.forEach(m => {
    results.push({
        category: 'media',
        message: `Media file detected in critical path (before LCP)`,
        recommendation: `Lazy load media files after the LCP`,
        url: m.url,
        passing: false,
        time: m.start,
        initiator: getInitiator(har, m.url),
    });
  });
  return results;
}
