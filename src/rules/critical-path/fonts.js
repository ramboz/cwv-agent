import { getSequence } from '../shared.js';

export default function evaluate({ report }) {
  const { sequence } = getSequence(report);

  const fonts = sequence.filter(r => r.entryType === 'resource' && r.mimeType.includes('font'));
  const results = [];
  fonts.forEach(f => {
    results.push({
        category: 'critical-path',
        message: `Font file detected in loading sequence (before LCP)`,
        recommendation: `Move font files after the LCP to improve performance and use the font fallback technique to prevent CLS`,
        url: f.url,
        passing: false,
        time: f.start,
      });
  });
  return results;
}
