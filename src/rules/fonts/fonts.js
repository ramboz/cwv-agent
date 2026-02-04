import { getInitiator } from '../shared.js';

/**
 * Checks if a Google Fonts URL has the display parameter configured
 * @param {String} url - The Google Fonts CSS URL
 * @return {Object|null} - Analysis result or null if not a Google Fonts URL
 */
function analyzeGoogleFontsUrl(url) {
  if (!url || !url.includes('fonts.googleapis.com/css')) {
    return null;
  }
  try {
    const urlObj = new URL(url);
    const displayParam = urlObj.searchParams.get('display');
    return {
      isGoogleFonts: true,
      url,
      hasDisplayParam: !!displayParam,
      displayValue: displayParam,
      hasDisplaySwap: displayParam === 'swap',
    };
  } catch (e) {
    return null;
  }
}

/**
 * Normalize font family names for matching (remove quotes, handle variations)
 * @param {String} name - Font family name
 * @return {String} Normalized name
 */
function normalizeFamily(name) {
  return (name || '').replace(/['"]/g, '').trim();
}

/**
 * Evaluate font loading and configuration for CWV optimization
 * @param {Object} params - Rule parameters
 * @param {Object} params.har - HAR data
 * @param {Object} params.fontData - Font analysis data from font-analyzer.js
 * @return {Array|null} Array of rule results or null
 */
export default function evaluate({ har, fontData }) {
  // Ensure we have HAR data with font entries
  const allFonts = har?.log?.entries?.filter((e) => e.response?.content?.mimeType?.includes('font')) || [];
  if (!allFonts.length && !fontData) {
    return null;
  }

  const results = [];

  // Check Google Fonts URLs for display parameter
  // This provides explicit verification since we now have reliable font-display detection
  const cssEntries = har?.log?.entries?.filter((e) => e.response?.content?.mimeType?.includes('text/css')) || [];
  cssEntries.forEach((e) => {
    const analysis = analyzeGoogleFontsUrl(e.request.url);
    if (analysis) {
      if (analysis.hasDisplaySwap) {
        // Record passing check so LLM knows font-display is correctly configured
        results.push({
          category: 'fonts',
          message: 'Google Fonts URL correctly includes display=swap parameter',
          url: e.request.url,
          time: e.time,
          passing: true,
        });
      } else {
        results.push({
          category: 'fonts',
          message: analysis.hasDisplayParam
            ? `Google Fonts URL uses display=${analysis.displayValue} instead of display=swap`
            : 'Google Fonts URL is missing the display parameter',
          url: e.request.url,
          time: e.time,
          recommendation: 'Add &display=swap to the Google Fonts URL to prevent invisible text during font loading',
          passing: false,
          initiator: getInitiator(har, e.request.url),
        });
      }
    }
  });

  // Check woff2 font format
  allFonts.forEach((e) => {
    if (!e.response.content.mimeType.includes('woff2')) {
      results.push({
        category: 'fonts',
        message: 'Non optimal font format detected',
        url: e.request.url,
        time: e.time,
        recommendation: 'Make sure to use custom fonts that are in the WOFF2 format',
        passing: false,
        initiator: getInitiator(har, e.request?.url),
      });
    }
  });

  // Use fontData from font-analyzer.js (uses document.fonts API - works for all fonts)
  if (fontData && fontData.fonts && fontData.usedFonts) {
    const fonts = fontData.fonts;
    const usedFonts = fontData.usedFonts;
    const mainFonts = Object.keys(usedFonts);

    // Find loaded fonts that are actually used in the page
    const loadedFonts = fonts.filter((f) => {
      const normalizedFamily = normalizeFamily(f.family);
      return f.status === 'loaded' && mainFonts.some((m) => normalizeFamily(m) === normalizedFamily);
    });

    loadedFonts.forEach((f) => {
      const normalizedFamily = normalizeFamily(f.family);

      // Check font-display property
      if (f.display === 'swap') {
        // Record passing check so LLM knows font-display is correctly configured
        results.push({
          category: 'fonts',
          message: `Font ${f.family} correctly uses font-display: swap`,
          name: f.family,
          passing: true,
        });
      } else if (f.display === 'optional') {
        // Optional is also acceptable
        results.push({
          category: 'fonts',
          message: `Font ${f.family} uses font-display: optional`,
          name: f.family,
          passing: true,
        });
      } else {
        results.push({
          category: 'fonts',
          message: `Non optimal font loading detected for ${f.family} (font-display: ${f.display || 'auto'})`,
          recommendation: 'Use font-display: swap or optional to prevent invisible text during font loading',
          name: f.family,
          passing: false,
        });
      }

      // Check for fallback fonts
      const usedFontsKey = mainFonts.find((m) => normalizeFamily(m) === normalizedFamily);
      if (usedFontsKey && usedFonts[usedFontsKey].length === 0) {
        results.push({
          category: 'fonts',
          message: `No fallback font detected for ${f.family}`,
          recommendation: 'Configure fallback fonts to prevent layout shifts if the primary font fails to load',
          name: f.family,
          passing: false,
        });
      }
    });

    // Check fallback fonts for size adjustment
    const fallbackFontNames = Array.from(new Set(Object.values(usedFonts).flat()));
    const fallbackFonts = fonts.filter((f) => fallbackFontNames.includes(normalizeFamily(f.family)));

    fallbackFonts.forEach((f) => {
      if (f.sizeAdjust === '100%' || !f.sizeAdjust) {
        results.push({
          category: 'fonts',
          message: `Fallback font ${f.family} is not size-adjusted to mimic the custom fonts`,
          recommendation: 'Configure size-adjust property so the custom font does not shift content when injected',
          name: f.family,
          passing: false,
        });
      }
    });

    // Include any issues detected by font-analyzer.js
    if (fontData.issues && fontData.issues.length > 0) {
      fontData.issues.forEach((issue) => {
        // Avoid duplicates - only add issues not already covered
        const isDuplicate = results.some(
          (r) => r.name === issue.fontFamily && r.message.includes(issue.type.replace(/-/g, ' '))
        );
        if (!isDuplicate) {
          results.push({
            category: 'fonts',
            message: `${issue.type}: ${issue.fontFamily}`,
            recommendation: issue.recommendation,
            name: issue.fontFamily,
            passing: false,
          });
        }
      });
    }
  }

  return results.length > 0 ? results : null;
}
