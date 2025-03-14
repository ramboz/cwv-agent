import { getSequence } from './shared.js';

export default function evaluate({ report }) {
  const sequence = getSequence(report);

  const hasFont = sequence.some(r => r.entrType === 'resource' && r.mimeType.includes('font'));
  if (hasFont) {
    return {
        category: 'loading-sequence',
        message: `Font file detected in loading sequence (before LCP)`,
        recommendation: `Move font files after the LCP to improve performance and use the font fallback technique to prevent CLS`,
        passing: false,
        time: sequence[sequence.length - 1].start,
      }
  }
  return null;
}
