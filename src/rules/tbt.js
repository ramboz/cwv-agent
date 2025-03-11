const THRESHOLD = 90;

export default function evaluate({ report }) {
  // use dataSortedByEnd to get the previous entries by end time
  const { dataSortedByEnd: data } = report;

  const tbts = data.filter(e => e.type === 'TBT');

  if (tbts.length > 0) {
    const processed = new Set();
    return tbts.map((e) => {
      const { id, duration, start } = e;
      let type, previous;
      let previousIndex = data.findIndex(e => e.id === id) - 1;
      do {
        if (previousIndex > 0) {
          previous = data[previousIndex--];
          type = previous.type;
        }
      } while (type === 'TBT' && previous);

      if (type === 'long-animation-frame' || !previous || processed.has(previous.id)) {
        // Ignore TBT if it's caused by a long animation frame or if it's already processed (several TBTs in a row)
        return null;
      }
      processed.add(previous.id);
      
      return {
        category: 'tbt',
        message: `${duration}ms blocking time`,
        recommendation: `Remove blocking time: most likely caused by ${previous.entryType} (${previous.url}) loaded as ${previous.type}`,
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