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
        category: 'fonts',
        message: 'Use a modern font format',
        url: e.request.url,
        time: e.time.toFixed(0),
        recommendation: 'Make sure to use custom fonts that are in the WOFF2 format.',
        passing: false,
      })
    }
  });

  // Check "font-display: swap" and fallback fonts
  const mainFonts = Object.keys(jsApi.usedFonts);
  const loadedFonts = jsApi.fonts.filter((f) => f.status === 'loaded' && mainFonts.includes(f.fontFamily));
  loadedFonts.forEach((f) => {
    if (f.display !== 'swap') {
      results.push({
        category: 'fonts',
        message: `Gracefully swap in ${f.family} when the font is loaded`,
        recommendation: 'Make sure to use the swap display property for custom fonts.',
        passing: false,
      });
    }
    if (!jsApi.usedFonts[f.fontFamily].length) {
      results.push({
        category: 'fonts',
        message: `Font ${f.family} has no fallback font.`,
        recommendation: 'Make sure to use configure fallback fonts to be shown while your custom fonts load.',
        passing: false,
      });
    }
  });

  const fallbackFontNames = Array.from(new Set(Object.values(jsApi.usedFonts).map((ff) => ff[0])));
  const fallbackFonts = jsApi.fonts.filter((f) => fallbackFontNames.includes(f.family));

  // Check that fallback fonts are size adjusted
  fallbackFonts.forEach((f) => {
    if (f.sizeAdjust === '100%') {
      results.push({
        category: 'fonts',
        message: 'Size fallback fonts to mimic custom fonts.',
        recommendation: 'Make sure to use the swap display property for custom fonts.',
        passing: false,
      });
    }
  });

  return results;
}