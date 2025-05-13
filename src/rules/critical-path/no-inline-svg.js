import { parse } from 'node-html-parser';

export default function evaluate({ summary, fullHtml }) {
  const doc = parse(fullHtml);
  const svgElements = doc.querySelectorAll('body svg');
  if (svgElements.length > 0) {
    return [...svgElements].map((el) => ({
      category: 'critical-path',
      message: 'Inline SVGs found on the page',
      recommendation: 'Remove inline SVGs from the page, and replace them by <img> tags with loading="lazy" attribute.',
      element: el.outerHTML.substring(0, 256),
      passing: false,
    }));
  }
  return null;
}
