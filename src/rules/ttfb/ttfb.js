const THRESHOLD = 800;
export default function evaluate({ report }) {
  const entry = report.data.find(d => d.entryType === 'navigation' && d.ttfb);
  if (entry?.ttfb > THRESHOLD) {
    return { 
      passing: false,
      category: 'network',
      message: `Large time to first byte (TTFB) detected (${entry.ttfb}ms)`,
      recommendation: 'Reduce TTFB by reviewing your CDN configuration and caching rules to improve the performance',
      url: entry.url,
      time: entry.start,
    };
  }
  return null;
}