import { parse as parseHTML } from 'node-html-parser';

/**
 * Analyzes image attributes from HTML to identify optimization opportunities
 * Focuses on: loading, fetchpriority, width/height, decoding, preload hints
 *
 * @param {string} html - Raw HTML content
 * @param {Object} perfEntries - Performance entries to match LCP element
 * @returns {Object} Image analysis results
 */
export function analyzeImages(html, perfEntries = null) {
  if (!html) {
    return { images: [], summary: 'No HTML content available for image analysis' };
  }

  const root = parseHTML(html);
  const images = root.querySelectorAll('img');
  const lcpImageUrl = perfEntries?.lcp?.element?.url;

  const imageAnalysis = Array.from(images).map(img => {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    const srcset = img.getAttribute('srcset');

    return {
      src,
      srcset: srcset || null,
      loading: img.getAttribute('loading'), // lazy, eager, auto
      fetchpriority: img.getAttribute('fetchpriority'), // high, low, auto
      width: img.getAttribute('width'),
      height: img.getAttribute('height'),
      decoding: img.getAttribute('decoding'), // async, sync, auto
      alt: img.getAttribute('alt'),
      isLCP: lcpImageUrl ? src?.includes(lcpImageUrl) || srcset?.includes(lcpImageUrl) : false,
      // Check for common lazy loading patterns
      hasDataSrc: !!img.getAttribute('data-src'),
      classList: img.getAttribute('class') || ''
    };
  });

  // Analyze preload hints in <head>
  const preloadLinks = root.querySelectorAll('link[rel="preload"]');
  const preloadedImages = Array.from(preloadLinks)
    .filter(link => link.getAttribute('as') === 'image')
    .map(link => ({
      href: link.getAttribute('href'),
      fetchpriority: link.getAttribute('fetchpriority'),
      imagesrcset: link.getAttribute('imagesrcset'),
      imagesizes: link.getAttribute('imagesizes')
    }));

  return {
    images: imageAnalysis,
    preloadHints: preloadedImages,
    summary: summarizeImageAnalysis(imageAnalysis, preloadedImages)
  };
}

/**
 * Summarizes image analysis for agent consumption
 * @param {Array} images - Array of image analysis objects
 * @param {Array} preloadHints - Array of preload hints
 * @returns {string} Markdown formatted summary
 */
function summarizeImageAnalysis(images, preloadHints) {
  if (images.length === 0) {
    return '**Image Analysis:** No images found in HTML';
  }

  let report = `**Image Analysis:**\n\n`;
  report += `* **Total Images:** ${images.length}\n\n`;

  // Find LCP image
  const lcpImage = images.find(img => img.isLCP);
  if (lcpImage) {
    report += `* **LCP Image Attributes:**\n`;
    report += `  * URL: \`${lcpImage.src}\`\n`;
    report += `  * Loading: ${lcpImage.loading || 'not set (defaults to eager)'}\n`;
    report += `  * Fetchpriority: ${lcpImage.fetchpriority || 'not set (defaults to auto)'}\n`;
    report += `  * Width/Height: ${lcpImage.width && lcpImage.height ? `${lcpImage.width}x${lcpImage.height} ✅` : '❌ Missing (causes CLS)'}\n`;
    report += `  * Decoding: ${lcpImage.decoding || 'not set (defaults to auto)'}\n`;

    // Check for issues
    const lcpIssues = [];
    if (lcpImage.loading === 'lazy') {
      lcpIssues.push('❌ LCP image has loading="lazy" (delays LCP!)');
    }
    if (lcpImage.fetchpriority !== 'high') {
      lcpIssues.push('⚠️ LCP image missing fetchpriority="high" (recommended)');
    }
    if (!lcpImage.width || !lcpImage.height) {
      lcpIssues.push('❌ LCP image missing width/height (causes CLS)');
    }

    if (lcpIssues.length > 0) {
      report += `\n  **Issues:**\n`;
      lcpIssues.forEach(issue => {
        report += `  * ${issue}\n`;
      });
    }
    report += `\n`;
  }

  // Check for lazy-loaded images that should be eager
  const aboveFoldLazy = images.filter(img =>
    img.loading === 'lazy' && !img.isLCP
  ).slice(0, 5); // First 5 are likely above fold

  if (aboveFoldLazy.length > 0) {
    report += `* **Potentially Mis-Lazy-Loaded Images (above fold):**\n`;
    aboveFoldLazy.forEach(img => {
      report += `  * \`${img.src}\` - has loading="lazy" but might be visible initially\n`;
    });
    report += `\n`;
  }

  // Check for images missing dimensions
  const missingDimensions = images.filter(img => !img.width || !img.height);
  if (missingDimensions.length > 0) {
    report += `* **Images Missing Width/Height (${missingDimensions.length} total, causes CLS):**\n`;
    missingDimensions.slice(0, 5).forEach(img => {
      report += `  * \`${img.src}\`\n`;
    });
    if (missingDimensions.length > 5) {
      report += `  * ...and ${missingDimensions.length - 5} more\n`;
    }
    report += `\n`;
  }

  // Check preload hints
  if (preloadHints.length > 0) {
    report += `* **Preload Hints:**\n`;
    preloadHints.forEach(hint => {
      const priority = hint.fetchpriority ? `, fetchpriority="${hint.fetchpriority}"` : '';
      report += `  * \`${hint.href}\`${priority}\n`;
    });

    // Check if LCP image is preloaded
    if (lcpImage && !preloadHints.some(hint => hint.href?.includes(lcpImage.src))) {
      report += `\n  ⚠️ **LCP image is NOT preloaded** - consider adding:\n`;
      report += `  \`<link rel="preload" as="image" href="${lcpImage.src}" fetchpriority="high">\`\n`;
    }
    report += `\n`;
  } else if (lcpImage) {
    report += `* **Preload Hints:** None found\n`;
    report += `  ⚠️ **Recommendation:** Preload the LCP image:\n`;
    report += `  \`<link rel="preload" as="image" href="${lcpImage.src}" fetchpriority="high">\`\n\n`;
  }

  // Summary stats
  const stats = {
    withLoading: images.filter(img => img.loading).length,
    withFetchpriority: images.filter(img => img.fetchpriority).length,
    withDimensions: images.filter(img => img.width && img.height).length,
    lazyLoaded: images.filter(img => img.loading === 'lazy').length
  };

  report += `* **Attribute Coverage:**\n`;
  report += `  * loading: ${stats.withLoading}/${images.length} (${Math.round(stats.withLoading/images.length*100)}%)\n`;
  report += `  * fetchpriority: ${stats.withFetchpriority}/${images.length} (${Math.round(stats.withFetchpriority/images.length*100)}%)\n`;
  report += `  * width/height: ${stats.withDimensions}/${images.length} (${Math.round(stats.withDimensions/images.length*100)}%)\n`;
  report += `  * lazy-loaded: ${stats.lazyLoaded}/${images.length} (${Math.round(stats.lazyLoaded/images.length*100)}%)\n`;

  return report;
}

/**
 * Matches image analysis with LCP element from performance entries
 * @param {Array} images - Image analysis array
 * @param {Object} lcpEntry - LCP performance entry
 * @returns {Object} Matched image with LCP data
 */
export function matchLCPImage(images, lcpEntry) {
  if (!lcpEntry || !images || images.length === 0) {
    return null;
  }

  const lcpUrl = lcpEntry.url || lcpEntry.element?.url;
  if (!lcpUrl) return null;

  const matched = images.find(img =>
    img.src?.includes(lcpUrl) || img.srcset?.includes(lcpUrl)
  );

  if (matched) {
    return {
      ...matched,
      lcpTime: lcpEntry.startTime,
      lcpSize: lcpEntry.size
    };
  }

  return null;
}
