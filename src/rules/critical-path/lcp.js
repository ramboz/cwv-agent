const THRESHOLDS = {
  average: 2500,
  bad: 4000,
};

export default function evaluate({ report }) {
  const data = report.dataSortedByEnd;
  const lcps = data.filter(r => r.entryType === 'LCP');
  
  const results = [];
  if (lcps.length > 0) {
    const lcp = lcps[lcps.length - 1];
    const { element, start, url } = lcp;
    if (lcps.length > 1) {
      results.push({
        category: 'critical-path',
        message: `Multiple LCPs found`,
        recommendation: `Having multiple LCPs might lead to performance issues as the critical path might be optimized for the first FCP. Or you have async content coming in late that overshadows the LCP itself.`,
        passing: false,
        time: start,
        elements: lcps.map(l => l.element),
      });
    }
    if (lcp.end > THRESHOLDS.average) {

      if (lcp.end > THRESHOLDS.bad) {
        results.push({
          category: 'critical-path',
          message: `LCP timing is bad`,
          recommendation: `The LCP element is taking too long to load. Load it earlier during the critical path.`,
          passing: false,
          time: start,
          url,
          element,
        });
      } else {
        results.push({
          category: 'critical-path',
          message: `LCP timing is average`,
          recommendation: `The LCP element is taking too long to load. Load it earlier during the critical path.`,
          passing: false,
          time: start,
          url,
          element,
        });
      }
    }
  }
  return results;
}