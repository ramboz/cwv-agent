import { getSequence } from './shared.js';

export default function evaluate({ report }) {
  const sequence = getSequence(report);

  const fonts = sequence.filter(r => r.entryType === 'resource' && r.mimeType.includes('font'));
  if (fonts.length > 0) {
    return {
        category: 'loading-sequence',
        message: `Font file detected in loading sequence (before LCP)`,
        recommendation: `Move font files after the LCP to improve performance and use the font fallback technique to prevent CLS`,
        url: fonts.map(f => f.url).join(', '),
        passing: false,
        time: sequence[sequence.length - 1].start,
      }
  }
  return null;
}
