export default function evaluate({ summary, har }) {
  const { hostname } = new URL(summary.url);
  const allModernProtocol = har.log.entries
    .filter((e) => new URL(e.request.url).hostname === hostname)
    .every((e) => ['h3', 'h2'].includes(e.request.httpVersion));
  if (!allModernProtocol) {
    return {
      category: 'network',
      message: 'Legacy HTTP version detected for first-part resource',
      recommendation: 'Configured your CDN to use HTTP/2 or HTTP/3 for all first-party requests to speed up the page load',
      passing: false,
    };
  }
  return null;
}