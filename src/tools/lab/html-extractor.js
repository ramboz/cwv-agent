/**
 * CWV-Relevant HTML Extraction
 * Extracts only the HTML sections relevant for Core Web Vitals analysis
 * Reduces token count from ~333K to ~30K by focusing on critical rendering path
 */

import { DISPLAY_LIMITS } from '../../config/thresholds.js';

/**
 * Extract CWV-relevant HTML sections from a page
 * Focuses on: head metadata, LCP candidates, lazy-load issues, unsized images, third-party scripts
 *
 * @param {Object} page - Puppeteer page instance
 * @return {Promise<String>} JSON string of extracted HTML data
 */
export async function extractCwvRelevantHtml(page) {
  return await page.evaluate((maxClassNames, maxLcpCandidates, sampleSize) => {
    /**
     * Generate minimal CSS selector for an element
     * @param {Element} element - DOM element
     * @return {String|null} CSS selector
     */
    const getSelector = (element) => {
      if (!element) return null;
      let selector = element.tagName.toLowerCase();
      if (element.id) {
        selector += `#${element.id}`;
      } else if (element.className && typeof element.className === 'string') {
        const classes = element.className.trim().split(/\s+/).slice(0, maxClassNames);
        selector += classes.map((c) => `.${c}`).join('');
      }
      return selector;
    };

    /**
     * Categorize third-party scripts by purpose
     * @param {String} hostname - Script hostname
     * @return {String} Category name
     */
    const categorizeScript = (hostname) => {
      if (hostname.includes('cookielaw') || hostname.includes('onetrust')) return 'consent';
      if (hostname.includes('gtm') || hostname.includes('analytics') || hostname.includes('googletagmanager')) return 'analytics';
      if (hostname.includes('adobedtm') || hostname.includes('launch')) return 'tag-manager';
      if (hostname.includes('facebook') || hostname.includes('twitter') || hostname.includes('linkedin')) return 'social';
      if (hostname.includes('hotjar') || hostname.includes('fullstory') || hostname.includes('logrocket')) return 'monitoring';
      return 'other';
    };

    // Extract <head> metadata critical for CWV
    const head = {
      preload: Array.from(document.querySelectorAll('link[rel="preload"]')).map((l) => ({
        href: l.href,
        as: l.as,
        type: l.type,
        fetchpriority: l.fetchPriority,
      })),
      // Separate font preloads for easier analysis
      fontPreloads: Array.from(document.querySelectorAll('link[rel="preload"][as="font"]')).map((l) => ({
        href: l.href,
        type: l.type,
        crossorigin: l.crossOrigin,
        fetchpriority: l.fetchPriority,
      })),
      preconnect: Array.from(document.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]')).map((l) => ({
        rel: l.rel,
        href: l.href,
        crossorigin: l.crossOrigin,
      })),
      renderBlockingStyles: Array.from(document.querySelectorAll('link[rel="stylesheet"]:not([media="print"])')).map((l) => ({
        href: l.href,
        media: l.media || 'all',
      })),
      scripts: Array.from(document.querySelectorAll('script[src]')).map((s) => ({
        src: s.src,
        async: s.async,
        defer: s.defer,
        type: s.type,
        nomodule: s.noModule,
        dataRouting: s.getAttribute('data-routing'),
      })),
      inlineScripts: document.querySelectorAll('script:not([src])').length,
      meta: {
        viewport: document.querySelector('meta[name="viewport"]')?.content,
        charset: document.querySelector('meta[charset]')?.getAttribute('charset'),
      },
    };

    // Find LCP candidates (large images, hero sections)
    const lcpCandidates = Array.from(document.querySelectorAll('img, [style*="background-image"]'))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        // Substantial size (likely above-fold)
        return rect.width > 300 && rect.height > 200 && rect.top < window.innerHeight;
      })
      .slice(0, maxLcpCandidates)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        selector: getSelector(el),
        width: el.width || el.clientWidth,
        height: el.height || el.clientHeight,
        loading: el.loading,
        fetchpriority: el.fetchPriority,
        src: el.src || el.currentSrc,
        hasBackgroundImage: !!el.style.backgroundImage,
        aboveFold: el.getBoundingClientRect().top < window.innerHeight,
      }));

    // Find lazy-loaded images above fold (performance anti-pattern)
    const lazyLoadAboveFold = Array.from(document.querySelectorAll('img[loading="lazy"]'))
      .filter((img) => {
        const rect = img.getBoundingClientRect();
        return rect.top < window.innerHeight;
      })
      .map((img) => ({
        selector: getSelector(img),
        src: img.src,
      }));

    // Find images without dimensions (CLS risk)
    const imagesWithoutDimensions = Array.from(document.querySelectorAll('img'))
      .filter((img) => !img.hasAttribute('width') || !img.hasAttribute('height'))
      .slice(0, sampleSize)
      .map((img) => ({
        selector: getSelector(img),
        src: img.src,
      }));

    // Third-party scripts (often impact CWV)
    const thirdPartyScripts = Array.from(document.querySelectorAll('script[src]'))
      .map((s) => {
        try {
          const url = new URL(s.src);
          const isThirdParty = url.hostname !== window.location.hostname;
          return isThirdParty
            ? {
                src: s.src,
                hostname: url.hostname,
                async: s.async,
                defer: s.defer,
                type: s.type || 'text/javascript',
                category: categorizeScript(url.hostname),
                inHead: document.head.contains(s),
                isLikelyLarge: s.src.length > 100,
              }
            : null;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    return JSON.stringify(
      {
        head,
        lcpCandidates,
        lazyLoadAboveFold,
        imagesWithoutDimensions,
        thirdPartyScripts,
      },
      null,
      2
    );
  }, DISPLAY_LIMITS.LAB.MAX_CLASS_NAMES, DISPLAY_LIMITS.LAB.MAX_LCP_CANDIDATES, DISPLAY_LIMITS.LAB.SAMPLE_SIZE);
}

/**
 * Summarize extracted HTML data for agent consumption
 * @param {String} htmlJson - JSON string from extractCwvRelevantHtml
 * @return {String} Human-readable summary
 */
export function summarizeHtmlExtraction(htmlJson) {
  if (!htmlJson) {
    return 'HTML extraction unavailable.';
  }

  try {
    const data = typeof htmlJson === 'string' ? JSON.parse(htmlJson) : htmlJson;
    const lines = [];

    lines.push('## HTML Analysis\n');

    // Head summary
    const { head } = data;
    lines.push('**Head Resources:**');
    lines.push(`- Preload hints: ${head.preload?.length || 0}`);
    lines.push(`- Font preloads: ${head.fontPreloads?.length || 0}`);
    lines.push(`- Preconnect hints: ${head.preconnect?.length || 0}`);
    lines.push(`- Render-blocking stylesheets: ${head.renderBlockingStyles?.length || 0}`);
    lines.push(`- Scripts: ${head.scripts?.length || 0}`);
    lines.push(`- Inline scripts: ${head.inlineScripts || 0}`);

    // LCP candidates
    if (data.lcpCandidates?.length > 0) {
      lines.push(`\n**LCP Candidates (${data.lcpCandidates.length}):**`);
      data.lcpCandidates.slice(0, 3).forEach((el) => {
        lines.push(`- ${el.selector}: ${el.width}x${el.height}, loading=${el.loading || 'eager'}, priority=${el.fetchpriority || 'auto'}`);
      });
    }

    // Issues
    if (data.lazyLoadAboveFold?.length > 0) {
      lines.push(`\n**⚠️ Lazy-loaded images above fold (${data.lazyLoadAboveFold.length}):**`);
      data.lazyLoadAboveFold.slice(0, 3).forEach((img) => {
        lines.push(`- ${img.selector}`);
      });
    }

    if (data.imagesWithoutDimensions?.length > 0) {
      lines.push(`\n**⚠️ Images without dimensions (${data.imagesWithoutDimensions.length}):**`);
      data.imagesWithoutDimensions.slice(0, 3).forEach((img) => {
        lines.push(`- ${img.selector}`);
      });
    }

    // Third-party scripts
    if (data.thirdPartyScripts?.length > 0) {
      const byCategory = data.thirdPartyScripts.reduce((acc, s) => {
        acc[s.category] = (acc[s.category] || 0) + 1;
        return acc;
      }, {});
      lines.push(`\n**Third-party scripts (${data.thirdPartyScripts.length}):**`);
      Object.entries(byCategory).forEach(([cat, count]) => {
        lines.push(`- ${cat}: ${count}`);
      });
    }

    return lines.join('\n');
  } catch (e) {
    return `HTML extraction parse error: ${e.message}`;
  }
}
