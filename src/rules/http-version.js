import { getSequence } from './shared.js';

export default function evaluate({ summary, har }) {
  const { hostname } = new URL(summary.url);
  const allModernProtocol = har.log.entries
    .filter((e) => new URL(e.request.url).hostname === hostname)
    .every((e) => ['h3', 'h2'].includes(e.request.httpVersion));
  if (!allModernProtocol) {
    return {
      category: 'lcp',
      message: 'Some first party resources are not served using HTTP/2 or HTTP/3.',
      recommendation: 'Configured your CDN to use HTTP/2 or HTTP/3.',
      passing: false,
    };
  }
  return {
    category: 'lcp',
    message: 'All first party resources are using HTTP/2 or HTTP/3.',
    recommendation: 'Http version is well optimized.',
    passing: true,
  };
}