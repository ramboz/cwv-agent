/**
 * Detects the AEM implementation type from HTML source code
 * @param {string} headers - The headers of the page
 * @param {string} htmlSource - The HTML source code of the page
 * @return {string|null} - 'eds', 'cs', 'ams', or null if undetermined
 */
export function detectAEMVersion(headers, htmlSource) {
  if (!htmlSource || typeof htmlSource !== 'string') {
    return null;
  }

  // Create a normalized version of the HTML for simpler pattern matching
  const normalizedHtml = htmlSource.toLowerCase();

  // EDS Indicators
  const edsPatterns = [
    // Core library references
    /lib-franklin\.js/i,
    /aem\.js/i,
    // Block structure
    /data-block-status/i,
    // Franklin-specific markup patterns
    /scripts\.js/i,
    // Block HTML patterns
    /<div class="[^"]*block[^"]*"[^>]*>/i
  ];

  // CS Indicators (Cloud Service)
  const csPatterns = [
    // Core Components patterns
    /<div class="[^"]*cmp-[^"]*"[^>]*>/i,
    // Modern clientlib paths
    /\/etc\.clientlibs\//i,
    /\/libs\.clientlibs\//i,
    // Core components comments or data attributes
    /data-cmp-/i,
    /data-sly-/i,
    // Cloud Manager references
    /content\/experience-fragments\//i,
    // SPA editor references
    /data-cq-/i
  ];

  // AMS Indicators (Managed Services) - typically older AEM patterns
  const amsPatterns = [
    // Legacy clientlib paths
    /\/etc\/clientlibs\//i,
    /\/etc\/designs\//i,
    // Classic UI patterns
    /foundation-/i,
    /cq:template/i,
    /cq-commons/i,
    // Legacy component patterns
    /parsys/i,
    // Legacy CQ references
    /\/CQ\//i,
    /\/apps\//i
  ];

  // Count matches for each type
  let edsMatches = 0;
  let csMatches = 0;
  let amsMatches = 0;

  // Check EDS patterns
  for (const pattern of edsPatterns) {
    if (pattern.test(normalizedHtml)) {
      edsMatches++;
    }
  }

  // Check CS patterns
  for (const pattern of csPatterns) {
    if (pattern.test(normalizedHtml)) {
      csMatches++;
    }
  }

  // Check AMS patterns
  for (const pattern of amsPatterns) {
    if (pattern.test(normalizedHtml)) {
      amsMatches++;
    }
  }

  // Check for decisive indicators with higher weight
  if (normalizedHtml.includes('lib-franklin.js') || normalizedHtml.includes('aem.js')) {
    edsMatches += 3;
  }
  
  if (normalizedHtml.includes('/etc.clientlibs/') || normalizedHtml.match(/class="[^"]*cmp-[^"]*"/)) {
    csMatches += 2;
  }
  
  if (normalizedHtml.includes('/etc/designs/') || normalizedHtml.includes('foundation-')) {
    amsMatches += 2;
  }

  // Determine the most likely version based on match counts
  const maxMatches = Math.max(edsMatches, csMatches, amsMatches);
  
  // Require a minimum threshold of matches to make a determination
  const MIN_THRESHOLD = 2;
  
  if (maxMatches < MIN_THRESHOLD) {
    return null;
  }
  
  if (edsMatches === maxMatches && edsMatches > csMatches && edsMatches > amsMatches) {
    return 'eds';
  } else if (csMatches === maxMatches && csMatches > edsMatches && csMatches > amsMatches) {
    return 'cs';
  } else if (amsMatches === maxMatches && amsMatches > edsMatches && amsMatches > csMatches) {
    return 'ams';
  }
  
  // If there's a tie or unclear result
  return null;
}