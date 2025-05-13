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
    /<div class="[^"]*block[^"]*"[^>]*>/i,
    // RUM data-routing for EDS
    /data-routing="[^"]*eds=([^,"]*)/i
  ];

  // CS Indicators (Cloud Service)
  const csPatterns = [
    // Core Components patterns
    /<div class="[^"]*cmp-[^"]*"[^>]*>/i,
    // Modern clientlib paths
    /\/etc\.clientlibs\//i,
    /\/libs\.clientlibs\//i,
    // CS-specific clientlib pattern with lc- prefix/suffix
    /\/etc\.clientlibs\/[^"']+\.lc-[a-f0-9]+-lc\.min\.js/i,
    // Core components comments or data attributes
    /data-cmp-/i,
    /data-sly-/i,
    // Cloud Manager references
    /content\/experience-fragments\//i,
    // SPA editor references
    /data-cq-/i,
    // RUM data-routing for CS
    /data-routing="[^"]*cs=([^,"]*)/i
  ];

  // AMS Indicators (Managed Services) - typically older AEM patterns
  const amsPatterns = [
    // Legacy clientlib paths
    /\/etc\/clientlibs\//i,
    /\/etc\/designs\//i,
    // AMS-specific clientlib pattern with fingerprinted hashes
    /\/etc\.clientlibs\/[^"']+\.min\.[a-f0-9]{32}\.js/i,
    // Classic UI patterns
    /foundation-/i,
    /cq:template/i,
    /cq-commons/i,
    // Legacy component patterns
    /parsys/i,
    // Legacy CQ references
    /\/CQ\//i,
    /\/apps\//i,
    // RUM data-routing for AMS
    /data-routing="[^"]*ams=([^,"]*)/i
  ];

  const aemHeadlessPatterns = [
    /aem-headless/i,
    /\/content\/dam\//i
  ];

  // Count matches for each type
  let edsMatches = 0;
  let csMatches = 0;
  let amsMatches = 0;
  let aemHeadlessMatches = 0;

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

  for (const pattern of aemHeadlessPatterns) {
    if (pattern.test(normalizedHtml)) {
      aemHeadlessMatches++;
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
  
  // Give extra weight to AMS clientlib format pattern as it's very distinctive
  if (/\/etc\.clientlibs\/[^"']+\.min\.[a-f0-9]{32}\.js/i.test(normalizedHtml)) {
    amsMatches += 3;
  }
  
  // Give extra weight to CS clientlib format pattern as it's very distinctive
  if (/\/etc\.clientlibs\/[^"']+\.lc-[a-f0-9]+-lc\.min\.js/i.test(normalizedHtml)) {
    csMatches += 3;
  }
  
  // Give significant weight to explicit RUM data-routing indicators
  if (/data-routing="[^"]*ams=([^,"]*)/i.test(normalizedHtml)) {
    amsMatches += 5;
  }
  
  if (/data-routing="[^"]*eds=([^,"]*)/i.test(normalizedHtml)) {
    edsMatches += 5;
  }
  
  if (/data-routing="[^"]*cs=([^,"]*)/i.test(normalizedHtml)) {
    csMatches += 5;
  }

  // Determine the most likely version based on match counts
  const maxMatches = Math.max(edsMatches, csMatches, amsMatches, aemHeadlessMatches);
  
  // Require a minimum threshold of matches to make a determination
  const MIN_THRESHOLD = 2;
  
  if (maxMatches < MIN_THRESHOLD) {
    return null;
  }
  
  if (edsMatches === maxMatches && edsMatches > csMatches && edsMatches > amsMatches && edsMatches > aemHeadlessMatches) {
    return 'eds';
  } else if (csMatches === maxMatches && csMatches > edsMatches && csMatches > amsMatches && csMatches > aemHeadlessMatches) {
    return 'cs';
  } else if (amsMatches === maxMatches && amsMatches > edsMatches && amsMatches > csMatches && amsMatches > aemHeadlessMatches) {
    return 'ams';
  } else if (aemHeadlessMatches === maxMatches && aemHeadlessMatches > edsMatches && aemHeadlessMatches > csMatches && aemHeadlessMatches > amsMatches) {
    return 'aem-headless';
  }

  // If there's a tie or unclear result
  return null;
}