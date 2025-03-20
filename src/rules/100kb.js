const THRESHOLDS = {
  mobile: 100,
  desktop: 200,
};

export default function evaluate({ summary, report }) {
  const data = report.dataSortedByEnd;
  const i = data.findLastIndex(r => r.entryType === 'LCP');
  const lcpResource = data[i];
  const { element, start } = lcpResource;
  const beforeLCP = data.slice(0, i);
  const totalSizeBeforeLCP = beforeLCP.reduce((acc, r) => acc + (r.size || 0), 0);
  if (totalSizeBeforeLCP > THRESHOLDS[summary.type]) {
    return {
      category: 'lcp',
      message: `>${THRESHOLDS[summary.type]}kb on ${summary.type} pre-lcp assets`,
      recommendation: `${totalSizeBeforeLCP}kb loaded before the LCP - remove resources loaded before the LCP to reduce the size of the initial page load and speed up the LCP.`,
      element,
      passing: false,
      time: start,
    };
  }
  return {
    category: 'lcp',
    message: `<${THRESHOLDS[summary.type]}kb on ${summary.type} pre-lcp assets`,
    recommendation: 'LCP is good!',
    element,
    passing: true,
    time: start,
  };
}