const THRESHOLDS = {
  average: 2500,
  bad: 4000,
};

export default function evaluate({ report }) {
  const { data } = report;
  const lcps = data.filter(r => r.entryType === 'LCP');
  
  const results = [];
  if (lcps.length > 0) {
    const lcp = lcps[lcps.length - 1];
    const { element, start } = lcp;
    if (lcps.length > 1) {
      results.push({
        category: 'lcp',
        message: `Multiple LCPs found`,
        recommendation: `Having multiple LCPs might lead to performance issues as the loading sequence might be optimized for the first LCP.`,
        passing: false,
        time: start,
        elements: lcps.map(l => l.element),
      });
    }
    if (lcp.end > THRESHOLDS.average) {
      if (lcp.end > THRESHOLDS.bad) {
        results.push({
          category: 'lcp',
          message: `LCP is bad!`,
          recommendation: `The LCP element is taking too long to load. Load it earlier during the loading sequence.`,
          passing: false,
          time: start,
          element,
        });
      } else {
        results.push({
          category: 'lcp',
          message: `LCP is average!`,
          recommendation: `The LCP element is taking too long to load. Load it earlier during the loading sequence.`,
          passing: true,
          time: start,
          element,
        });
      }
    } else {
      results.push({
        category: 'lcp',
        message: `LCP is good!`,
        passing: true,
        time: start,
        element,
      });
    }
  }
  return results;
}