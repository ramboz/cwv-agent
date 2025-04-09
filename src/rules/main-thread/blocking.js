import { getSequence, getInitiator } from '../shared.js';

export default function evaluate({ report, har }) {
  const { sequence } = getSequence(report);

  const blocking = sequence.filter(r => r.entryType === 'resource' && !r.url.includes('/styles.css') && r.renderBlockingStatus === 'blocking');
  const results = [];
  blocking.forEach(b => {
    results.push({
        category: 'main-thread',
        message: `Resource is blocking the main thread`,
        recommendation: `Consider deferring the loading of this resource or at least make it non-blocking`,
        url: b.url,
        passing: false,
        time: b.start,
        initiator: getInitiator(har, b.url),
      });
  });
  return results;
}
