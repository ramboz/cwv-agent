/**
 * Font Analysis Module
 * Consolidated font analysis using document.fonts API as the primary source
 * (works reliably for all fonts including third-party like Google Fonts)
 */

/**
 * Collect comprehensive font data from the page
 * Uses document.fonts.ready as the primary source (works for all fonts regardless of origin)
 * Optionally supplements with stylesheet analysis where accessible
 *
 * @param {Object} page - Puppeteer page instance
 * @return {Promise<Object>} Font analysis results
 */
export async function collectFontData(page) {
  return await page.evaluate(() => {
    /**
     * Analyze fonts using the FontFace API (primary source - works for all fonts)
     * @return {Promise<Object>} Font data from document.fonts
     */
    async function analyzeFontFaceApi() {
      const fontsSet = await document.fonts.ready;
      return [...fontsSet].map((ff) => ({
        family: ff.family,
        display: ff.display,
        status: ff.status,
        weight: ff.weight,
        style: ff.style,
        stretch: ff.stretch,
        unicodeRange: ff.unicodeRange,
        variant: ff.variant,
        featureSettings: ff.featureSettings,
        ascentOverride: ff.ascentOverride,
        descentOverride: ff.descentOverride,
        lineGapOverride: ff.lineGapOverride,
        sizeAdjust: ff.sizeAdjust,
      }));
    }

    /**
     * Get fonts actually used by common page elements
     * Uses getComputedStyle which works regardless of stylesheet origin
     * @return {Object} Map of primary font -> fallback fonts array
     */
    function getUsedFonts() {
      const selectors = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'p', 'button', 'a', 'span'];
      const usedFonts = {};

      selectors.forEach((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;

        const fontFamily = window.getComputedStyle(el).fontFamily;
        if (!fontFamily) return;

        // Parse font-family stack: "Primary Font", fallback1, fallback2
        const fonts = fontFamily.split(',').map((f) => f.trim().replace(/['"]/g, ''));
        const primary = fonts[0];
        const fallbacks = fonts.slice(1);

        if (!usedFonts[primary]) {
          usedFonts[primary] = fallbacks;
        }
      });

      return usedFonts;
    }

    /**
     * Analyze @font-face rules from accessible stylesheets (supplementary)
     * Note: This won't work for cross-origin stylesheets (e.g., Google Fonts CSS)
     * but provides additional details for self-hosted fonts
     * @return {Object} Stylesheet-based font analysis
     */
    function analyzeStylesheets() {
      const fontFaces = [];
      const externalProviders = new Set();
      let fontsWithSwap = 0;
      let fontsWithOptional = 0;
      let fontsWithBlock = 0;
      let fontsWithoutDisplay = 0;

      try {
        Array.from(document.styleSheets).forEach((sheet, idx) => {
          try {
            const rules = Array.from(sheet.cssRules || sheet.rules || []);
            rules.forEach((rule) => {
              if (rule.type === CSSRule.FONT_FACE_RULE) {
                const fontFamily = rule.style.getPropertyValue('font-family')?.replace(/['"]/g, '') || 'unknown';
                const fontDisplay = rule.style.getPropertyValue('font-display') || null;
                const fontWeight = rule.style.getPropertyValue('font-weight') || 'normal';
                const fontStyle = rule.style.getPropertyValue('font-style') || 'normal';
                const src = rule.style.getPropertyValue('src');
                const unicodeRange = rule.style.getPropertyValue('unicode-range') || null;

                // Extract font URL
                let fontUrl = null;
                if (src) {
                  const urlMatch = src.match(/url\(['"]?([^'"]+)['"]?\)/);
                  fontUrl = urlMatch ? urlMatch[1] : null;
                }

                // Track external providers
                if (fontUrl) {
                  try {
                    const url = new URL(fontUrl, window.location.href);
                    if (!url.hostname.includes(window.location.hostname)) {
                      externalProviders.add(url.hostname);
                    }
                  } catch (e) {
                    // Relative URL, self-hosted
                  }
                }

                // Count font-display strategies
                if (fontDisplay === 'swap') fontsWithSwap++;
                else if (fontDisplay === 'optional') fontsWithOptional++;
                else if (fontDisplay === 'block') fontsWithBlock++;
                else if (!fontDisplay) fontsWithoutDisplay++;

                // Check if preloaded
                const isPreloaded = Array.from(document.querySelectorAll('link[rel="preload"][as="font"]'))
                  .some((link) => fontUrl && link.href.includes(fontUrl.split('/').pop()));

                fontFaces.push({
                  family: fontFamily,
                  weight: fontWeight,
                  style: fontStyle,
                  display: fontDisplay,
                  url: fontUrl ? fontUrl.substring(0, 100) : null,
                  unicodeRange,
                  isPreloaded,
                  stylesheet: sheet.href || `inline-${idx}`,
                });
              }
            });
          } catch (e) {
            // Cross-origin stylesheet - this is expected for Google Fonts, Adobe Fonts, etc.
            // The FontFace API (primary source) will still have this font's data
          }
        });
      } catch (e) {
        // Stylesheet analysis failed entirely
      }

      return {
        fontFaces,
        externalProviders: Array.from(externalProviders),
        summary: {
          totalFromStylesheets: fontFaces.length,
          fontsWithSwap,
          fontsWithOptional,
          fontsWithBlock,
          fontsWithoutDisplay,
        },
      };
    }

    /**
     * Check for font preloads in the document head
     * @return {Array} Font preload link data
     */
    function getFontPreloads() {
      return Array.from(document.querySelectorAll('link[rel="preload"][as="font"]')).map((link) => ({
        href: link.href,
        type: link.type,
        crossorigin: link.crossOrigin,
        fetchpriority: link.fetchPriority,
      }));
    }

    // Execute analysis
    return (async () => {
      const fonts = await analyzeFontFaceApi();
      const usedFonts = getUsedFonts();
      const stylesheetAnalysis = analyzeStylesheets();
      const fontPreloads = getFontPreloads();

      // Build summary
      const loadedFonts = fonts.filter((f) => f.status === 'loaded');
      const fontsWithSwap = fonts.filter((f) => f.display === 'swap').length;
      const fontsWithOptional = fonts.filter((f) => f.display === 'optional').length;
      const fontsWithBlock = fonts.filter((f) => f.display === 'block').length;
      const fontsWithAuto = fonts.filter((f) => f.display === 'auto' || !f.display).length;

      // Identify issues
      const issues = [];

      // Check fonts without proper font-display
      fonts.forEach((f) => {
        if (f.status === 'loaded' && f.display !== 'swap' && f.display !== 'optional') {
          issues.push({
            type: 'missing-font-display-swap',
            fontFamily: f.family,
            currentDisplay: f.display || 'auto',
            recommendation: 'Use font-display: swap or optional to prevent invisible text during font loading',
            severity: 'high',
          });
        }
      });

      // Check for fonts without fallbacks
      Object.entries(usedFonts).forEach(([primary, fallbacks]) => {
        if (fallbacks.length === 0) {
          issues.push({
            type: 'missing-fallback-font',
            fontFamily: primary,
            recommendation: 'Add fallback fonts to prevent layout shifts if the primary font fails to load',
            severity: 'medium',
          });
        }
      });

      // Generate assessment
      let assessment;
      if (fonts.length === 0) {
        assessment = 'No custom fonts detected (using system fonts only)';
      } else if (fontsWithSwap + fontsWithOptional === fonts.length) {
        assessment = 'Good: All fonts use font-display: swap or optional';
      } else if (fontsWithBlock > 0 || fontsWithAuto > 0) {
        assessment = `Warning: ${fontsWithBlock + fontsWithAuto} font(s) may cause invisible text (FOIT) during loading`;
      } else {
        assessment = 'Font loading strategy detected';
      }

      return {
        // Primary data source (reliable for all fonts including Google Fonts)
        fonts,
        usedFonts,
        fontPreloads,

        // Supplementary data (only for accessible stylesheets)
        stylesheetAnalysis,

        // Summary
        summary: {
          totalFonts: fonts.length,
          loadedFonts: loadedFonts.length,
          fontsWithSwap,
          fontsWithOptional,
          fontsWithBlock,
          fontsWithAuto,
          preloadedFonts: fontPreloads.length,
          externalProviders: stylesheetAnalysis.externalProviders,
        },

        issues,
        assessment,
      };
    })();
  });
}

/**
 * Summarize font analysis for agent consumption
 * @param {Object} fontData - Font analysis data
 * @return {String} Human-readable summary
 */
export function summarizeFontAnalysis(fontData) {
  if (!fontData) {
    return 'Font analysis unavailable.';
  }

  const { fonts, usedFonts, summary, issues, assessment } = fontData;
  const lines = [];

  lines.push(`## Font Analysis\n`);
  lines.push(`**Assessment:** ${assessment}\n`);

  // Summary stats
  lines.push(`**Statistics:**`);
  lines.push(`- Total fonts loaded: ${summary.totalFonts}`);
  lines.push(`- With font-display: swap: ${summary.fontsWithSwap}`);
  lines.push(`- With font-display: optional: ${summary.fontsWithOptional}`);
  lines.push(`- With font-display: block: ${summary.fontsWithBlock}`);
  lines.push(`- With font-display: auto (default): ${summary.fontsWithAuto}`);
  lines.push(`- Preloaded fonts: ${summary.preloadedFonts}`);

  if (summary.externalProviders.length > 0) {
    lines.push(`- External font providers: ${summary.externalProviders.join(', ')}`);
  }

  // Fonts in use
  if (Object.keys(usedFonts).length > 0) {
    lines.push(`\n**Fonts in use:**`);
    Object.entries(usedFonts).forEach(([primary, fallbacks]) => {
      const fallbackStr = fallbacks.length > 0 ? ` → fallbacks: ${fallbacks.join(', ')}` : ' (no fallbacks!)';
      lines.push(`- ${primary}${fallbackStr}`);
    });
  }

  // Issues
  if (issues.length > 0) {
    lines.push(`\n**Issues detected (${issues.length}):**`);
    issues.forEach((issue) => {
      lines.push(`- [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.fontFamily}`);
      lines.push(`  Recommendation: ${issue.recommendation}`);
    });
  }

  // Detailed font list
  if (fonts.length > 0 && fonts.length <= 10) {
    lines.push(`\n**Loaded fonts detail:**`);
    fonts.forEach((f) => {
      lines.push(`- ${f.family} (${f.weight} ${f.style}): display=${f.display || 'auto'}, status=${f.status}`);
    });
  }

  return lines.join('\n');
}
