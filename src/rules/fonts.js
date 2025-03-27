export default function evaluate({ har, perfEntries, jsApi }) {
  const allFonts = har.log.entries.filter((e) => e.response.content.mimeType.includes('font'));
  if (!allFonts.length) {
    return null;
  }
  const allModernFonts = allFonts.every((e) => e.response.content.mimeType.includes('woff2'));
  if (!allModernFonts) {
    return {
      category: 'lcp',
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

  const loadedFonts = jsApi.fonts.filter((f) => f.status === 'loaded');
  const allFontsUseSwap = loadedFonts.every((f) => f.display === 'swap');
  if (!allFontsUseSwap) {
    return {
      category: 'lcp',
      message: 'Gracefully swap custom fonts when they are loaded.',
      recommendation: 'Make sure to use the swap display property for custom fonts.',
      passing: false,
    };
  }

  // Check that fallback fonts are used
  const fallbackFonts = jsApi.fonts.filter((f) => f.status === 'unloaded');
  if (loadedFonts.length > 0 && !fallbackFonts.length) {
    return {
      category: 'lcp',
      message: 'Use fallback fonts for all your custom fonts.',
      recommendation: 'Make sure to use configure fallback fonts to be shown while your custom fonts load.',
      passing: false,
    };
  }

  // Check that fallback fonts are size adjusted
  const allFallbackFontsSizeAdjusted = fallbackFonts.every((f) => f.sizeAdjust !== '100%');
  if (!allFallbackFontsSizeAdjusted) {
    return {
      category: 'lcp',
      message: 'Size fallback fonts to mimic custom fonts.',
      recommendation: 'Make sure to use the swap display property for custom fonts.',
      passing: false,
    };
  }
  return null;
}