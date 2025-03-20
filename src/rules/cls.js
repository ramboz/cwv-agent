import { cacheResults } from '../utils.js';

export default function evaluate({ report }) {
  // use dataSortedByEnd to get the previous entries by end time
  const data = report.dataSortedByEnd;

  const clss = data.filter(e => e.entryType === 'CLS');
  if (clss.length > 0) {
    const processed = new Set();
    return clss.map((e) => {
      const { id, sources, value, start } = e;
      let mimeType, previous;
      let previousIndex = data.findIndex(e => e.id === id) - 1;
      do {
        if (previousIndex > 0) {
          previous = data[previousIndex];
          mimeType = previous.mimeType;
        }
        previousIndex--;
      } while (/*mimeType !== 'text/css' &&*/ mimeType !== 'text/javascript' && mimeType !== 'text/css' && previousIndex > 0);

      if (!previous) {
        return null;
      }
      processed.add(previous.id);

      const source = sources[sources.length - 1];
      const { node } = source;
      let recommendation = `Fix width and height before element or impacting CSS is loaded - root cause seems to be the LCP element`;
      if (previous.entryType === 'resource') {
        recommendation = `Fix width and height before element or impacting CSS is loaded - Root cause seems to be ${previous.url}`;
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
    category: 'cls',
    message: 'No layout shift',
    passing: true,
  };
}