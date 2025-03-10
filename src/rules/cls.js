import { cacheResults } from '../utils.js';

export default function evaluate({ report }) {
  report.data.sort((a, b) => a.endTime - b.endTime);

  const clss = report.data.filter(e => e.type === 'CLS');

  if (clss.length > 0) {
    const processed = new Set();
    return clss.map((e) => {
      const { id, sources, value } = e;
      let type, previous;
      let previousIndex = report.data.findIndex(e => e.id === id) - 1;
      do {
        if (previousIndex > 0) {
          previous = report.data[previousIndex];
          type = previous.type;
        }
        previousIndex--;
      } while (/*type !== 'script' &&*/ type !== 'link' && type !== 'LCP' && previousIndex > 0);

      if (!previous) {
        return null;
      }
      processed.add(previous.id);

      const source = sources[sources.length - 1];
      const { node } = source;
      let recommendation = `Fix width and height before element is loaded. Root cause seems to be the LCP element.`;
      if (previous.entryType === 'resource') {
        recommendation = `Fix width and height before element is loaded. Root cause seems to be ${previous.entryType} (${previous.url}) loaded as ${previous.type}`;
      }
      return {
        category: 'cls',
        message: `CLS (${value}) - Element ${node} moves.`,
        recommendation,
        passing: false,
      };
    }).filter(Boolean);
  }
  return {
    category: 'tbt',
    message: 'No blocking time',
    passing: true,
  };
}