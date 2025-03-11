import { cacheResults } from '../utils.js';

export default function evaluate({ report }) {
  // use dataSortedByEnd to get the previous entries by end time
  const { dataSortedByEnd: data } = report;

  const clss = data.filter(e => e.type === 'CLS');

  if (clss.length > 0) {
    const processed = new Set();
    return clss.map((e) => {
      const { id, sources, value, start } = e;
      let type, previous;
      let previousIndex = data.findIndex(e => e.id === id) - 1;
      do {
        if (previousIndex > 0) {
          previous = data[previousIndex];
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
      let recommendation = `Fix width and height before element or impacting CSS is loaded - root cause seems to be the LCP element`;
      if (previous.entryType === 'resource') {
        recommendation = `Fix width and height before element or impacting CSS is loaded - Root cause seems to be ${previous.entryType} (${previous.url}) loaded as ${previous.type}`;
      }
      return {
        category: 'cls',
        message: `Element moves (${value})`,
        recommendation,
        element: node,
        passing: false,
        time: start,
      };
    }).filter(Boolean);
  }
  return {
    category: 'tbt',
    message: 'No blocking time',
    passing: true,
  };
}