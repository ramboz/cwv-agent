export default function evaluate({ har, perfEntries }) {
  const allFonts = har.log.entries.filter((e) => e.response.content.mimeType.includes('font'));
  if (!allFonts.length) {
    return null;
  }
  const allModernFonts = allFonts.every((e) => e.response.content.mimeType.includes('woff2'));
  if (!allModernFonts) {
    return {
      category: 'fonts',
      message: 'Use a modern font format for custom fonts',
      recommendation: 'Make sure to use custom fonts that are in the WOFF2 format.',
      passing: false,
    };
  }

  const lcp = perfEntries.find((e) => e.entryType === 'largest-contentful-paint');
  if (!lcp || !lcp.url) {
    return null;
  }
  const lcpIndex = har.log.entries.findIndex((e) => e.request.url === lcp.url);  
  const fontIndex = har.log.entries.findIndex((e) => e.response.content.mimeType.includes('font'));
  if (lcpIndex > -1 && fontIndex > -1 && lcpIndex > fontIndex) {
    return {
      category: 'lcp',
      message: 'Load custom fonts lazily.',
      recommendation: 'Make sure to load custom fonts after the LCP element.',
      passing: false,
    };
  }
  return null;
}