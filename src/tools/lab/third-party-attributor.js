/**
 * Third-Party Script Attribution
 * Analyzes third-party scripts with detailed categorization, execution time, and blocking impact
 */

/**
 * Check if URL is same-origin as page
 * @param {string} url - Resource URL
 * @param {string} pageUrl - Page URL
 * @returns {boolean}
 */
function isSameOrigin(url, pageUrl) {
  try {
    const resourceOrigin = new URL(url).origin;
    const pageOrigin = new URL(pageUrl).origin;
    return resourceOrigin === pageOrigin;
  } catch (e) {
    return false;
  }
}

/**
 * Categorize script by URL/domain
 * @param {string} url - Script URL
 * @param {string} domain - Domain name
 * @returns {string} Category
 */
function categorizeScript(url, domain) {
  const lowerUrl = url.toLowerCase();
  const lowerDomain = domain.toLowerCase();

  // Cookie Consent (NEVER LCP-critical, always defer)
  if (lowerDomain.includes('cookielaw') || lowerDomain.includes('onetrust') ||
      lowerDomain.includes('cookiebot') || lowerDomain.includes('cookieconsent') ||
      lowerDomain.includes('trustarc') || lowerDomain.includes('usercentrics')) {
    return 'consent';
  }

  // Analytics (NEVER LCP-critical, always async)
  if (lowerDomain.includes('google-analytics') || lowerDomain.includes('gtag') ||
      lowerDomain.includes('analytics') || lowerDomain.includes('segment') ||
      lowerDomain.includes('omniture') || lowerDomain.includes('omtrdc') ||
      (lowerDomain.includes('adobe') && lowerUrl.includes('analytics'))) {
    return 'analytics';
  }

  // Advertising (NEVER LCP-critical)
  if (lowerDomain.includes('doubleclick') || lowerDomain.includes('adsense') ||
      lowerDomain.includes('googlesyndication') || lowerDomain.includes('adnxs') ||
      lowerUrl.includes('/ads/') || lowerUrl.includes('/ad.')) {
    return 'advertising';
  }

  // Social (NEVER LCP-critical)
  if (lowerDomain.includes('facebook') || lowerDomain.includes('twitter') ||
      lowerDomain.includes('linkedin') || lowerDomain.includes('instagram') ||
      lowerDomain.includes('pinterest') || lowerDomain.includes('tiktok')) {
    return 'social';
  }

  // Tag managers (usually NOT LCP-critical, unless Target personalization)
  if (lowerDomain.includes('googletagmanager') || lowerDomain.includes('tealium') ||
      lowerDomain.includes('adobedtm') || lowerDomain.includes('launch.adobe') ||
      lowerDomain.includes('assets.adobedtm') || lowerDomain.includes('ensighten')) {
    return 'tag-manager';
  }

  // CDN (only if not first-party CDN)
  if ((lowerDomain.includes('cdn') || lowerDomain.includes('cloudfront') ||
       lowerDomain.includes('fastly') || lowerDomain.includes('akamai')) &&
      !lowerDomain.includes('adobe') && !lowerDomain.includes('company')) {
    return 'cdn';
  }

  // Payment (usually NOT LCP-critical)
  if (lowerDomain.includes('stripe') || lowerDomain.includes('paypal') ||
      lowerDomain.includes('braintree') || lowerDomain.includes('square')) {
    return 'payment';
  }

  // Customer support / Chat (NEVER LCP-critical)
  if (lowerDomain.includes('zendesk') || lowerDomain.includes('intercom') ||
      lowerDomain.includes('livechat') || lowerDomain.includes('drift') ||
      lowerDomain.includes('helpscout')) {
    return 'support';
  }

  // A/B Testing / Personalization (MAY be LCP-critical if above-fold personalization)
  if (lowerDomain.includes('optimizely') || lowerDomain.includes('vwo') ||
      lowerDomain.includes('abtasty') || lowerUrl.includes('at.js') ||
      lowerUrl.includes('target') || lowerDomain.includes('tt.omtrdc')) {
    return 'testing';
  }

  // RUM / Performance monitoring (NEVER LCP-critical)
  if (lowerDomain.includes('newrelic') || lowerDomain.includes('datadog') ||
      lowerDomain.includes('sentry') || lowerDomain.includes('hotjar') ||
      lowerDomain.includes('fullstory') || lowerDomain.includes('logrocket') ||
      lowerUrl.includes('rum')) {
    return 'monitoring';
  }

  return 'other';
}

/**
 * Categories that should NEVER be recommended for preconnect
 * These are non-LCP-critical and should be deferred/async
 */
const NON_CRITICAL_CATEGORIES = new Set([
  'consent',     // Cookie consent can always load after LCP
  'analytics',   // Analytics never affects rendering
  'advertising', // Ads don't block LCP
  'social',      // Social pixels are not rendering-critical
  'support',     // Chat widgets can load late
  'monitoring',  // RUM/monitoring is observational only
]);

/**
 * Check if a third-party category is LCP-critical
 * @param {string} category - Third-party category
 * @returns {boolean} True if category can affect LCP
 */
export function isLCPCriticalCategory(category) {
  return !NON_CRITICAL_CATEGORIES.has(category);
}

/**
 * Get recommendation for a third-party category
 * @param {string} category - Third-party category
 * @returns {Object} Recommendation object
 */
export function getCategoryRecommendation(category) {
  const recommendations = {
    'consent': {
      preconnect: false,
      action: 'defer',
      reason: 'Cookie consent banners never affect LCP - always defer to post-LCP'
    },
    'analytics': {
      preconnect: false,
      action: 'async',
      reason: 'Analytics does not affect rendering - always load async'
    },
    'advertising': {
      preconnect: false,
      action: 'defer',
      reason: 'Ads should not block page rendering - defer below fold'
    },
    'social': {
      preconnect: false,
      action: 'async',
      reason: 'Social pixels are never rendering-critical - load async'
    },
    'tag-manager': {
      preconnect: 'conditional',
      action: 'async unless Target',
      reason: 'Load async UNLESS Adobe Target does above-fold personalization'
    },
    'testing': {
      preconnect: 'conditional',
      action: 'depends on usage',
      reason: 'Only preconnect if doing above-fold A/B tests that could cause flicker'
    },
    'support': {
      preconnect: false,
      action: 'defer',
      reason: 'Chat widgets should load after main content - defer'
    },
    'monitoring': {
      preconnect: false,
      action: 'async',
      reason: 'RUM/monitoring is observational - load async'
    },
    'cdn': {
      preconnect: true,
      action: 'preconnect if LCP resource',
      reason: 'Preconnect only if CDN hosts LCP image or critical resources'
    },
    'other': {
      preconnect: 'unknown',
      action: 'analyze',
      reason: 'Analyze if this resource is in the LCP critical path'
    }
  };

  return recommendations[category] || recommendations['other'];
}

/**
 * Find script execution in performance entries
 * @param {string} scriptUrl - Script URL
 * @param {Object} performanceEntries - Performance entries
 * @returns {Object|null} Execution data
 */
function findScriptExecution(scriptUrl, performanceEntries) {
  if (!performanceEntries || !performanceEntries.longTasks) {
    return null;
  }

  const longTasks = performanceEntries.longTasks || [];
  const scriptDomain = new URL(scriptUrl).hostname;

  // Look for long animation frames (LoAF) attributed to this script
  const matchingTask = longTasks.find(task => {
    // Check if script attribution matches
    if (task.attribution && Array.isArray(task.attribution)) {
      return task.attribution.some(attr =>
        (attr.containerSrc && attr.containerSrc.includes(scriptUrl)) ||
        (attr.containerSrc && attr.containerSrc.includes(scriptDomain))
      );
    }
    return false;
  });

  if (matchingTask) {
    return {
      duration: matchingTask.duration,
      startTime: matchingTask.startTime,
      blockingDuration: matchingTask.duration > 50 ? matchingTask.duration - 50 : 0,
    };
  }

  return null;
}

/**
 * Find long tasks caused by this script
 * @param {string} scriptUrl - Script URL
 * @param {Object} performanceEntries - Performance entries
 * @returns {Array} Long tasks
 */
function findLongTasks(scriptUrl, performanceEntries) {
  if (!performanceEntries || !performanceEntries.longTasks) {
    return [];
  }

  const longTasks = performanceEntries.longTasks || [];
  const scriptDomain = new URL(scriptUrl).hostname;

  return longTasks
    .filter(task => {
      if (!task.attribution || !Array.isArray(task.attribution)) {
        return false;
      }
      return task.attribution.some(attr =>
        (attr.containerSrc && attr.containerSrc.includes(scriptUrl)) ||
        (attr.containerSrc && attr.containerSrc.includes(scriptDomain))
      );
    })
    .map(task => ({
      duration: task.duration,
      startTime: task.startTime,
      blockingDuration: task.duration > 50 ? task.duration - 50 : 0,
    }));
}

/**
 * Group array by property
 * @param {Array} arr - Array to group
 * @param {string} property - Property to group by
 * @returns {Object} Grouped object
 */
function groupBy(arr, property) {
  return arr.reduce((acc, item) => {
    const key = item[property];
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(item);
    return acc;
  }, {});
}

/**
 * Analyze third-party scripts with attribution
 * @param {Array} harEntries - HAR entries
 * @param {Object} performanceEntries - Performance Observer data
 * @param {string} pageUrl - Page URL
 * @returns {Object} Third-party analysis
 */
export function analyzeThirdPartyScripts(harEntries, performanceEntries, pageUrl) {
  if (!harEntries || !Array.isArray(harEntries)) {
    return {
      scripts: [],
      byCategory: {},
      categoryImpact: [],
      summary: {
        totalScripts: 0,
        totalTransferSize: 0,
        totalNetworkTime: 0,
        totalExecutionTime: 0,
        renderBlockingCount: 0,
      },
    };
  }

  const thirdPartyScripts = harEntries
    .filter(entry => {
      const resourceType = entry._resourceType || entry.type;
      return resourceType === 'script';
    })
    .filter(entry => !isSameOrigin(entry.request.url, pageUrl))
    .map(entry => {
      const url = entry.request.url;
      const domain = new URL(url).hostname;

      return {
        url,
        domain,
        category: categorizeScript(url, domain),

        // Network timing
        network: {
          wait: entry.timings.wait || 0,
          download: entry.timings.receive || 0,
          total: entry.time || 0,
        },

        // Size
        transferSize: entry.response.bodySize || 0,
        uncompressedSize: entry.response.content?.size || 0,

        // Execution attribution
        execution: findScriptExecution(url, performanceEntries),

        // Initiator chain (who loaded this?)
        initiator: {
          url: entry._initiator?.url,
          type: entry._initiator?.type, // 'script', 'parser', 'other'
          lineNumber: entry._initiator?.lineNumber,
        },

        // Blocking impact
        isRenderBlocking: entry._priority === 'VeryHigh' || entry._initiator?.type === 'parser',
        longTaskAttribution: findLongTasks(url, performanceEntries),
      };
    });

  // Group by category
  const byCategory = groupBy(thirdPartyScripts, 'category');

  // Calculate total impact per category
  const categoryImpact = Object.entries(byCategory).map(([category, scripts]) => ({
    category,
    scriptCount: scripts.length,
    totalTransferSize: scripts.reduce((sum, s) => sum + s.transferSize, 0),
    totalNetworkTime: scripts.reduce((sum, s) => sum + s.network.total, 0),
    totalExecutionTime: scripts.reduce((sum, s) => sum + (s.execution?.duration || 0), 0),
    totalBlockingTime: scripts.reduce((sum, s) => {
      const taskBlocking = s.longTaskAttribution.reduce((taskSum, task) => taskSum + task.blockingDuration, 0);
      return sum + taskBlocking;
    }, 0),
    isRenderBlocking: scripts.some(s => s.isRenderBlocking),
  }))
  .sort((a, b) => b.totalExecutionTime - a.totalExecutionTime); // Sort by execution time impact

  return {
    scripts: thirdPartyScripts,
    byCategory,
    categoryImpact,
    summary: {
      totalScripts: thirdPartyScripts.length,
      totalTransferSize: thirdPartyScripts.reduce((sum, s) => sum + s.transferSize, 0),
      totalNetworkTime: thirdPartyScripts.reduce((sum, s) => sum + s.network.total, 0),
      totalExecutionTime: thirdPartyScripts.reduce((sum, s) => sum + (s.execution?.duration || 0), 0),
      totalBlockingTime: thirdPartyScripts.reduce((sum, s) => {
        const taskBlocking = s.longTaskAttribution.reduce((taskSum, task) => taskSum + task.blockingDuration, 0);
        return sum + taskBlocking;
      }, 0),
      renderBlockingCount: thirdPartyScripts.filter(s => s.isRenderBlocking).length,
    },
  };
}
