const THRESHOLDS = {
  mobile: 100,
  desktop: 200,
};

export default function evaluate(summary, crux, psi, har, perfEntries, resources, report) {
  const lcpResource = report.data.findLast(r => r.type === 'LCP');
  const totalSizeBeforeLCP = report.data.slice(0, lcpResource.id).reduce((acc, r) => acc + (r.size || 0), 0);
  if (totalSizeBeforeLCP > THRESHOLDS[summary.type]) {
    return {
      category: 'lcp',
      message: `>${THRESHOLDS[summary.type]}kb on ${summary.type} pre-lcp assets`,
      recommendation: `${totalSizeBeforeLCP}kb loaded before the LCP - remove resources loaded before the LCP to reduce the size of the initial page load and speed up the LCP.`,
      passing: false,
    };
  }
  return {
    category: 'lcp',
    message: `<${THRESHOLDS[summary.type]}kb on ${summary.type} pre-lcp assets`,
    recommendation: 'LCP is good!',
    passing: true,
  };
}