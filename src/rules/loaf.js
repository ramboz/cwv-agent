const THRESHOLD = 90;

export default function evaluate({ report }) {
  const { data } = report;
  const lafs = data.filter(e => e.entryType === 'long-animation-frame' && e.duration > THRESHOLD);

  if (lafs.length > 0) {
    return lafs.map((e) => {
      const { url, name, duration, start, end } = e;
      if (url || name) {
        return {
          category: 'main-thread',
          message: `${duration.toFixed(0)}ms animation frame`,
          url: `${name || ''}${name && url ? ' in ' : ''}${url || ''}`,
          recommendation: 'Remove long animation frames to improve performance',
          passing: false,
          time: start,
        };
      } else {
        // find scripts and styles that are blocking the main thread during the animation frame
        const blockingResources = data.filter(e => e.entryType === 'resource' && e.start >= start && e.end <= end && (e.initiatorType === 'script' || e.initiatorType === 'link'));
        return {
          category: 'main-thread',
          message: `Blocking resource${blockingResources.length > 1 ? 's' : ''}`,
          url: blockingResources.map(e => e.url).join(', '),
          recommendation: `Review potential blocking resource${blockingResources.length > 1 ? 's' : ''} found during the animation frame`,
          passing: false,
          time: start,
        };
      }
    });
  }
  return null;
}