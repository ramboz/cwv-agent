const THRESHOLD = 90;

export default function evaluate({ report }) {
  const { data } = report;
  const lafs = data.filter(e => e.entryType === 'long-animation-frame' && e.duration > THRESHOLD);

  if (lafs.length > 0) {
    return lafs.map((e) => {
      const { url, name, duration, start } = e;
      return {
        category: 'long-animation-frame',
        message: `${duration.toFixed(0)}ms animation frame`,
        url: url || name || 'Inline script, inital navigation or other',
        recommendation: 'Remove long animation frames to improve performance',
        passing: false,
        time: start,
      };
    });
  }
  return {
    category: 'long-animation-frame',
    message: 'No long animation frames',
    passing: true,
  };
}