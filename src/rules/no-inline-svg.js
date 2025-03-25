import { parse } from 'node-html-parser';

export default function evaluate({ fullHtml }) {
  const doc = parse(fullHtml);
  const svgElements = doc.querySelectorAll('svg');
  if (svgElements.length > 0) {
    return {
      category: 'lcp',
      message: 'No inline SVGs found on the page.',
      recommendation: 'Remove inline SVGs from the page, and replace them by <img> tags with loading="lazy" attribute.',
      passing: false,
    };
  }
  return null;
}
