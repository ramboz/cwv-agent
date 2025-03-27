export default function evaluate({ har, jsApi }) {
  const allFonts = har.log.entries.filter((e) => e.response.content.mimeType.includes('font'));
  if (!allFonts.length) {
    return null;
  }

  // Check woff2 font format
  const results = [];
  allFonts.forEach((e) => {
    if (!e.response.content.mimeType.includes('woff2')) {
      results.push({
        category: 'lcp',
        message: `Use a modern font format for ${e.request.url}`,
        recommendation: 'Make sure to use custom fonts that are in the WOFF2 format.',
        passing: false,
      })
    }
  });  

  // Check "font-display: swap"
  const loadedFonts = jsApi.fonts.filter((f) => f.status === 'loaded');
  loadedFonts.forEach((f) => {
    if (f.display !== 'swap') {
      results.push({
        category: 'lcp',
        message: `Gracefully swap in ${f.family} when the font is loaded`,
        recommendation: 'Make sure to use the swap display property for custom fonts.',
        passing: false,
      });
    }
  });

  // Check that fallback fonts are used
  const fallbackFonts = jsApi.fonts.filter((f) => f.family.includes('fallback'));
  if (loadedFonts.length > 0 && !fallbackFonts.length) {
    results.push({
      category: 'lcp',
      message: 'Use fallback fonts for all your custom fonts.',
      recommendation: 'Make sure to use configure fallback fonts to be shown while your custom fonts load.',
      passing: false,
    });
  }

  // Check that fallback fonts are size adjusted
  fallbackFonts.forEach((f) => {
    if (f.sizeAdjust === '100%') {
      results.push({
        category: 'lcp',
        message: 'Size fallback fonts to mimic custom fonts.',
        recommendation: 'Make sure to use the swap display property for custom fonts.',
        passing: false,
      });
    }
  });

  return results;
}