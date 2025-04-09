export default function evaluate({ summary, har, perfEntries, report }) {
  const images = har.log.entries.filter((e) => e.response.content.mimeType.startsWith('image/'));
  const lcp = perfEntries.filter((e) => e.entryType === 'largest-contentful-paint').pop();
  if (!lcp) {
    return null;
  }
  const lcpResource = report.data.find((entry) => entry.entryType === 'resource' && entry.url === lcp.url);
  if (lcpResource) {
    const start = lcpResource.start;
    
    const lcpImage = images.find((img) => img.request.url === lcp.url);
    // const isLcpEagerlyLoaded = lcpImage && lcpImage._priority === 'High';
    const areAllLazyLoaded = images.every((img) => img._priority === 'Low' || img.request.url === lcp.url);

    if (areAllLazyLoaded) {
      return {
        category: 'critical-path',
        message: 'Images below the fold are not lazy loaded',
        recommendation: 'Ensure all images below the fold are loaded with `loading="lazy"`.',
        passing: false,
        time: start,
        initiator: summary.url,
      };
    // } else if (!isLcpEagerlyLoaded) {
    //   return {
    //     category: 'critical-path',
    //     message: 'LCP image is not eagerly loaded',
    //     recommendation: 'Ensure the LCP image is loaded with `loading="eager"` and `fetchpriority="high"`.',
    //     passing: false,
    //     time: start,
    //   };
    }
  } 
  return null;
}
