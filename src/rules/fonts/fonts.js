import { getInitiator } from '../shared.js';

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
        message: 'Non optimal font format detected',
        url: e.request.url,
        time: e.time,
        recommendation: 'Make sure to use custom fonts that are in the WOFF2 format',
        passing: false,
        initiator: getInitiator(har, e.url),
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
        message: `Non optimal font loading detected for ${f.family}`,
        recommendation: 'Make sure to use the swap display property for custom fonts so they are seamlessly injected in the page',
        name: f.family,
        passing: false,
      });
    }
    if (!jsApi.usedFonts[f.fontFamily].length) {
      results.push({
        category: 'fonts',
        message: `No fallback font detected for ${f.family}`,
        recommendation: 'Make sure to use configure fallback fonts to be shown while your custom fonts load to avoid a flash of unstyled text (FOUT)',
        name: f.family,
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
        message: 'Fallback font is not size-adjusted to mimic the custom fonts',
        recommendation: 'Make sure to configure the size-adjust property so that the custom font does not shift the content when injected',
        name: f.family,
        passing: false,
      });
    }
  });

  return results;
}