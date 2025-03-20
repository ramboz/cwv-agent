export default function evaluate({ har, perfEntries, report }) {
  const images = har.log.entries.filter((e) => e.response.content.mimeType.startsWith('image/'));
  const lcp = perfEntries.filter((e) => e.entryType === 'largest-contentful-paint').pop();
  const lcpImage = images.find((img) => img.request.url === lcp.url);
  const isLcpEagerlyLoaded = lcpImage && lcpImage._priority === 'High';
  const areAllLazyLoaded = images.every((img) => img._priority === 'Low' || img.request.url === lcp.url);
  const start = report.data.find((entry) => entry.entryType === 'resource' && entry.url === lcp.url).start;
  if (areAllLazyLoaded) {
    return {
      category: 'lcp',
      message: 'Images below the fold are not lazy loaded',
      recommendation: 'Ensure all images below the fold are loaded with `loading="lazy"`.',
      passing: false,
      time: start,
    };
  } else if (!isLcpEagerlyLoaded) {
    return {
      category: 'lcp',
      message: 'LCP image is not eagerly loaded',
      recommendation: 'Ensure the LCP image is loaded with `loading="eager"` and `fetchpriority="high"`.',
      passing: false,
      time: start,
    };
  }
  return {
    category: 'lcp',
    message: 'LCP image is loaded eagerly and all other iamges are lazy loaded',
    recommendation: 'Image loading is well optimized.',
    passing: true,
    time: start,
  };
}