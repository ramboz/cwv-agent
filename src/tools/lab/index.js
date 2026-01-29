import { cacheResults, getCachedResults } from '../../utils.js';
import { setupBrowser, waitForLCP } from './browser-utils.js';
import { summarizeHAR, startHARRecording, stopHARRecording } from './har-collector.js';
import { summarizePerformanceEntries, collectPerformanceEntries } from './performance-collector.js';
import { 
  summarizeCoverageData,
  setupCodeCoverage,
  collectLcpCoverage,
  collectPageCoverage,
} from './coverage-collector.js';
import { collectJSApiData, setupCSPViolationTracking } from './js-api-collector.js';
import { analyzeThirdPartyScripts } from './third-party-attributor.js';
import { attributeCLStoCSS, summarizeCLSAttribution } from './cls-attributor.js';

/**
 * Phase A Optimization: Extract only CWV-relevant HTML sections
 * Reduces token count from 333K to ~30K by focusing on critical rendering path
 */
async function extractCwvRelevantHtml(page) {
  return await page.evaluate(() => {
    // Helper: Generate minimal CSS selector
    const getSelector = (element) => {
      if (!element) return null;
      let selector = element.tagName.toLowerCase();
      if (element.id) {
        selector += `#${element.id}`;
      } else if (element.className && typeof element.className === 'string') {
        const classes = element.className.trim().split(/\s+/).slice(0, 2);
        selector += classes.map(c => `.${c}`).join('');
      }
      return selector;
    };

    // Extract <head> metadata critical for CWV
    const head = {
      preload: Array.from(document.querySelectorAll('link[rel="preload"]'))
        .map(l => ({
          href: l.href,
          as: l.as,
          type: l.type,
          fetchpriority: l.fetchPriority
        })),
      // Critical Gap Fix: Separate font preloads for easier analysis
      fontPreloads: Array.from(document.querySelectorAll('link[rel="preload"][as="font"]'))
        .map(l => ({
          href: l.href,
          type: l.type,
          crossorigin: l.crossOrigin,
          fetchpriority: l.fetchPriority
        })),
      preconnect: Array.from(document.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]'))
        .map(l => ({
          rel: l.rel,
          href: l.href,
          crossorigin: l.crossOrigin
        })),
      renderBlockingStyles: Array.from(document.querySelectorAll('link[rel="stylesheet"]:not([media="print"])'))
        .map(l => ({
          href: l.href,
          media: l.media || 'all'
        })),
      scripts: Array.from(document.querySelectorAll('script[src]'))
        .map(s => ({
          src: s.src,
          async: s.async,
          defer: s.defer,
          type: s.type,
          nomodule: s.noModule,
          dataRouting: s.getAttribute('data-routing')
        })),
      inlineScripts: document.querySelectorAll('script:not([src])').length,
      meta: {
        viewport: document.querySelector('meta[name="viewport"]')?.content,
        charset: document.querySelector('meta[charset]')?.getAttribute('charset')
      }
    };

    // Find LCP candidates (large images, hero sections)
    const lcpCandidates = Array.from(document.querySelectorAll('img, [style*="background-image"]'))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        // Substantial size (likely above-fold)
        return rect.width > 300 && rect.height > 200 && rect.top < window.innerHeight;
      })
      .slice(0, 10)  // Top 10 candidates
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        selector: getSelector(el),
        width: el.width || el.clientWidth,
        height: el.height || el.clientHeight,
        loading: el.loading,
        fetchpriority: el.fetchPriority,
        src: el.src || el.currentSrc,
        hasBackgroundImage: el.style.backgroundImage ? true : false,
        aboveFold: el.getBoundingClientRect().top < window.innerHeight
      }));

    // Find lazy-loaded images above fold (performance anti-pattern)
    const lazyLoadAboveFold = Array.from(document.querySelectorAll('img[loading="lazy"]'))
      .filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.top < window.innerHeight;
      })
      .map(img => ({
        selector: getSelector(img),
        src: img.src
      }));

    // Find images without dimensions (CLS risk)
    const imagesWithoutDimensions = Array.from(document.querySelectorAll('img'))
      .filter(img => !img.hasAttribute('width') || !img.hasAttribute('height'))
      .slice(0, 20)  // Sample 20
      .map(img => ({
        selector: getSelector(img),
        src: img.src
      }));

    // Third-party scripts (often impact CWV)
    // Use hostname-based detection instead of hardcoded list for completeness
    const categorizeScript = (hostname) => {
      if (hostname.includes('cookielaw') || hostname.includes('onetrust')) return 'consent';
      if (hostname.includes('gtm') || hostname.includes('analytics') || hostname.includes('googletagmanager')) return 'analytics';
      if (hostname.includes('adobedtm') || hostname.includes('launch')) return 'tag-manager';
      if (hostname.includes('facebook') || hostname.includes('twitter') || hostname.includes('linkedin')) return 'social';
      if (hostname.includes('hotjar') || hostname.includes('fullstory') || hostname.includes('logrocket')) return 'monitoring';
      return 'other';
    };

    const thirdPartyScripts = Array.from(document.querySelectorAll('script[src]'))
      .map(s => {
        try {
          const url = new URL(s.src);
          const isThirdParty = url.hostname !== window.location.hostname;
          return isThirdParty ? {
            src: s.src,
            hostname: url.hostname,
            async: s.async,
            defer: s.defer,
            type: s.type || 'text/javascript',
            category: categorizeScript(url.hostname),
            // Track position in document (useful for identifying render-blocking)
            inHead: document.head.contains(s),
            // Size info would come from network data, but we can note if it's likely large
            isLikelyLarge: s.src.length > 100 // Long URLs often indicate query params or large scripts
          } : null;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    // Recommended Improvement: Comprehensive font strategy analysis
    const fontStrategy = {
      fontFaces: [],
      issues: [],
      summary: {
        totalFonts: 0,
        preloadedFonts: 0,
        fontsWithSwap: 0,
        fontsWithOptional: 0,
        fontsWithBlock: 0,
        fontsWithoutDisplay: 0,
        externalFontProviders: new Set()
      }
    };

    try {
      // Analyze all @font-face rules
      Array.from(document.styleSheets).forEach((sheet, idx) => {
        try {
          const rules = Array.from(sheet.cssRules || sheet.rules || []);
          rules.forEach(rule => {
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

              // Determine if external provider (Google Fonts, Adobe Fonts, etc.)
              if (fontUrl) {
                try {
                  const url = new URL(fontUrl, window.location.href);
                  if (!url.hostname.includes(window.location.hostname)) {
                    fontStrategy.summary.externalFontProviders.add(url.hostname);
                  }
                } catch (e) {
                  // Relative URL, self-hosted
                }
              }

              // Count font-display strategies
              fontStrategy.summary.totalFonts++;
              if (fontDisplay === 'swap') fontStrategy.summary.fontsWithSwap++;
              else if (fontDisplay === 'optional') fontStrategy.summary.fontsWithOptional++;
              else if (fontDisplay === 'block') fontStrategy.summary.fontsWithBlock++;
              else if (!fontDisplay) fontStrategy.summary.fontsWithoutDisplay++;

              // Check if this font is preloaded
              const isPreloaded = Array.from(document.querySelectorAll('link[rel="preload"][as="font"]'))
                .some(link => fontUrl && link.href.includes(fontUrl.split('/').pop()));

              if (isPreloaded) {
                fontStrategy.summary.preloadedFonts++;
              }

              // Add to fontFaces list
              fontStrategy.fontFaces.push({
                family: fontFamily,
                weight: fontWeight,
                style: fontStyle,
                display: fontDisplay,
                url: fontUrl ? fontUrl.substring(0, 100) : null,
                unicodeRange: unicodeRange,
                isPreloaded: isPreloaded,
                stylesheet: sheet.href || `inline-${idx}`
              });

              // Flag issues
              if (!fontDisplay || fontDisplay === 'block') {
                fontStrategy.issues.push({
                  type: 'missing-font-display',
                  fontFamily: fontFamily,
                  currentValue: fontDisplay || 'not set',
                  recommendation: 'Use font-display: swap or optional to prevent CLS',
                  severity: 'high'
                });
              }

              // Flag if critical font not preloaded
              if (!isPreloaded && (fontWeight === 'normal' || fontWeight === '400') && fontStyle === 'normal') {
                fontStrategy.issues.push({
                  type: 'critical-font-not-preloaded',
                  fontFamily: fontFamily,
                  recommendation: `Add <link rel="preload" href="${fontUrl}" as="font" type="font/woff2" crossorigin>`,
                  severity: 'medium'
                });
              }

              // Flag subsetting opportunity
              if (!unicodeRange && fontUrl && !fontUrl.includes('googlefonts')) {
                fontStrategy.issues.push({
                  type: 'missing-subsetting',
                  fontFamily: fontFamily,
                  recommendation: 'Consider subsetting font to reduce file size (use unicode-range)',
                  severity: 'low'
                });
              }
            }
          });
        } catch (e) {
          // Cross-origin stylesheet, skip
        }
      });

      // Convert Set to Array for JSON serialization
      fontStrategy.summary.externalFontProviders = Array.from(fontStrategy.summary.externalFontProviders);

      // Add high-level assessment
      if (fontStrategy.summary.totalFonts === 0) {
        fontStrategy.assessment = 'No custom fonts detected (using system fonts)';
      } else if (fontStrategy.summary.fontsWithSwap + fontStrategy.summary.fontsWithOptional === fontStrategy.summary.totalFonts) {
        fontStrategy.assessment = 'Good: All fonts use font-display: swap or optional';
      } else if (fontStrategy.summary.fontsWithoutDisplay + fontStrategy.summary.fontsWithBlock > 0) {
        fontStrategy.assessment = `Warning: ${fontStrategy.summary.fontsWithoutDisplay + fontStrategy.summary.fontsWithBlock} fonts missing proper font-display (risk of CLS)`;
      }

    } catch (e) {
      fontStrategy.error = 'Font analysis failed: ' + e.message;
    }

    return JSON.stringify({
      head,
      lcpCandidates,
      lazyLoadAboveFold,
      imagesWithoutDimensions,
      thirdPartyScripts,
      fontStrategy
    }, null, 2);
  });
}

// Main Data Collection Function
export async function collect(pageUrl, deviceType, { skipCache, blockRequests, collectHar = true, collectCoverage = true }) {
  // Load cached artifacts
  let harFile = getCachedResults(pageUrl, deviceType, 'har');
  let perfEntries = getCachedResults(pageUrl, deviceType, 'perf');
  let fullHtml = getCachedResults(pageUrl, deviceType, 'html');
  let jsApi = getCachedResults(pageUrl, deviceType, 'jsapi');
  let coverageData = getCachedResults(pageUrl, deviceType, 'coverage');
  let thirdPartyAnalysis = getCachedResults(pageUrl, deviceType, 'third-party');
  let clsAttribution = getCachedResults(pageUrl, deviceType, 'cls-attribution');

  // Determine what we need to collect in this pass
  const needPerf = !perfEntries || skipCache;
  const needHtml = !fullHtml || skipCache;
  const needJsApi = !jsApi || skipCache;
  const needHar = collectHar && (!harFile || skipCache);
  const needCoverage = collectCoverage && (!coverageData || skipCache);

  // If nothing is needed, return from cache only what's relevant
  if (!needPerf && !needHtml && !needJsApi && !needHar && !needCoverage) {
    // Extract summary from cached CLS attribution if it exists
    const clsAttributionSummary = clsAttribution?.summary || clsAttribution || null;

    return {
      har: collectHar ? harFile : null,
      harSummary: collectHar && harFile ? summarizeHAR(harFile, deviceType, thirdPartyAnalysis) : null,
      perfEntries,
      perfEntriesSummary: summarizePerformanceEntries(perfEntries, deviceType, null, clsAttributionSummary),
      fullHtml,
      jsApi,
      coverageData: collectCoverage ? coverageData : null,
      coverageDataSummary: collectCoverage && coverageData ? summarizeCoverageData(coverageData, deviceType) : null,
      thirdPartyAnalysis,
      clsAttribution: clsAttributionSummary,
      fromCache: true,
    };
  }

  // Setup browser
  const { browser, page } = await setupBrowser(deviceType, blockRequests);

  // Setup code coverage tracking only if requested
  if (needCoverage) {
    await setupCodeCoverage(page);
  }

  // Setup CSP violation tracking
  await setupCSPViolationTracking(page);

  // Start HAR recording only if requested
  let har = null;
  if (needHar) {
    har = await startHARRecording(page);
  }

  // Navigate to page
  try {
    await page.goto(pageUrl, {
      timeout: 120_000,
      waitUntil: 'domcontentloaded',
    });
  } catch (err) {
    console.error('Page did not idle after 120s. Force continuing.', err.message);
  }

  // Collect coverage data at LCP
  try {
    await waitForLCP(page);
  } catch (err) {
    console.error('LCP not found after 30s. Force continuing.', err.message);
  }

  let lcpCoverageData = null;
  if (needCoverage) {
    try {
      lcpCoverageData = await collectLcpCoverage(page, pageUrl, deviceType);
    } catch (err) {
      console.error('Error collecting LCP coverage data:', err.message);
      lcpCoverageData = {}
    }
  }

  // Waiting for page to finish loading
  try {
    await page.waitForNetworkIdle({ concurrency: 0, idleTime: 1_000 });
  } catch (err) {
    // Do nothing
  }

  // Collect performance data
  if (needPerf) {
    perfEntries = await collectPerformanceEntries(page);
    cacheResults(pageUrl, deviceType, 'perf', perfEntries);
  }

  // Collect HAR data
  if (needHar) {
    harFile = await stopHARRecording(har);
    const count = Array.isArray(harFile?.log?.entries) ? harFile.log.entries.length : 0;
  }

  // Enhanced attribution: Third-party scripts (Priority 1)
  thirdPartyAnalysis = null;
  if (needHar && harFile && perfEntries) {
    try {
      thirdPartyAnalysis = analyzeThirdPartyScripts(
        harFile.log.entries,
        perfEntries,
        pageUrl
      );
      cacheResults(pageUrl, deviceType, 'third-party', thirdPartyAnalysis);
    } catch (err) {
      console.error('Error analyzing third-party scripts:', err.message);
    }
  }

  // Enhanced attribution: CLS-to-CSS mapping (Priority 2)
  clsAttribution = null;
  if (needPerf && perfEntries && perfEntries.layoutShifts && perfEntries.layoutShifts.length > 0) {
    try {
      clsAttribution = await attributeCLStoCSS(perfEntries.layoutShifts, page);
      const clsSummary = summarizeCLSAttribution(clsAttribution);
      cacheResults(pageUrl, deviceType, 'cls-attribution', { detailed: clsAttribution, summary: clsSummary });
    } catch (err) {
      console.error('Error attributing CLS to CSS:', err.message);
    }
  }

  // Collect HTML content
  // Phase A Optimization: Extract only CWV-relevant HTML sections instead of full page
  if (needHtml) {
    fullHtml = await extractCwvRelevantHtml(page);
  }
  cacheResults(pageUrl, deviceType, 'html', fullHtml);

  // Collect JavaScript API data
  if (needJsApi) {
    jsApi = await collectJSApiData(page);
  }
  cacheResults(pageUrl, deviceType, 'jsapi', jsApi);

  if (needCoverage) {
    try {
      coverageData = await collectPageCoverage(page, pageUrl, deviceType, lcpCoverageData);
    } catch (err) {
      console.error('Error collecting page coverage data:', err.message);
      coverageData = {}
    }
  }

  // Close browser and save results
  await browser.close();

  // Generate performance summary (with Priority 2 CLS attribution)
  let perfEntriesSummary = summarizePerformanceEntries(perfEntries, deviceType, null, clsAttribution);
  cacheResults(pageUrl, deviceType, 'perf', perfEntriesSummary);

  // Generate HAR summary (with Priority 1 third-party analysis)
  const harSummary = (collectHar && harFile) ? summarizeHAR(harFile, deviceType, thirdPartyAnalysis) : null;
  if (collectHar && harFile) {
    cacheResults(pageUrl, deviceType, 'har', harFile);
    cacheResults(pageUrl, deviceType, 'har', harSummary);
  }

  // Generate coverage usage summary
  const coverageDataSummary = (collectCoverage && coverageData) ? summarizeCoverageData(coverageData, deviceType) : null;
  if (collectCoverage && coverageData) {
    cacheResults(pageUrl, deviceType, 'coverage', coverageData);
    cacheResults(pageUrl, deviceType, 'coverage', coverageDataSummary);
  }

  // Return collected data
  return {
    har: collectHar ? harFile : null,
    harSummary,
    perfEntries,
    perfEntriesSummary,
    fullHtml,
    jsApi,
    coverageData: collectCoverage ? coverageData : null,
    coverageDataSummary,
    thirdPartyAnalysis,
    clsAttribution
  };
}
