import { getSequence } from './shared.js';

export default function evaluate({ report }) {
  const { sequence } = getSequence(report);

  const blocking = sequence.filter(r => r.entryType === 'resource' && !r.url.includes('/styles.css') && r.renderBlockingStatus === 'blocking');
  console.log('blocking', blocking);
  const results = [];
  blocking.forEach(b => {
    results.push({
        category: 'loading-sequence',
        message: `Resource is blocking the main thread`,
        recommendation: `Consider deferring the loading of this resource or at least make it non-blocking`,
        url: b.url,
        passing: false,
        time: b.start,
      });
  });
  return results;
}
