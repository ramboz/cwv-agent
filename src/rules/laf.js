const THRESHOLD = 90;

export default function evaluate(summary, crux, psi, har, perfEntries, resources, report) {
  const lafs = report.data.filter(e => e.type === 'long-animation-frame' && e.duration > THRESHOLD);

  if (lafs.length > 0) {
    return lafs.map((e) => {
      const { url, name, duration } = e;
      console.log('laf', e);
      return {
        category: 'long-animation-frame',
        message: `Long animation frames in ${url || name}: ${duration}ms`,
        recommendation: 'Remove long animation frames to improve performance',
        passing: false,
      };
    });
  }
  return {
    category: 'long-animation-frame',
    message: 'No long animation frames',
    passing: true,
  };
}