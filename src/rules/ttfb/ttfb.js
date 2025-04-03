const THRESHOLD = 800;
export default function evaluate({ report }) {
  const entry = report.data.find(d => d.entryType === 'navigation' && d.ttfb);
  if (entry.ttfb > THRESHOLD) {
    return { 
      passing: false,
      category: 'network',
      message: `TTFB is ${entry.ttfb}ms`,
      recommendation: 'Reduce TTFB to improve the performance',
      url: entry.url,
      time: entry.start,
    };
  }
  return null;
}