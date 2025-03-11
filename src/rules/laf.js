const THRESHOLD = 90;

export default function evaluate({ report }) {
  report.data.sort((a, b) => a.startTime - b.startTime);
  const lafs = report.data.filter(e => e.type === 'long-animation-frame' && e.duration > THRESHOLD);

  if (lafs.length > 0) {
    return lafs.map((e) => {
      const { url, name, duration } = e;
      return {
        category: 'long-animation-frame',
        message: `${duration}ms animation frame`,
        element: url || name,
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