/**
 * Detects the AEM implementation type from HTML source code
 * @param {string} htmlSource - The HTML source code of the page
 * @return {string|null} - 'eds', 'cs', 'ams', or null if undetermined
 */
export function detectAEMVersion(headers, htmlSource) {
  if (!htmlSource || typeof htmlSource !== 'string') {
    console.error('No HTML available. Cannot infer AEM version.');
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
    // CS-specific clientlib pattern with lc- prefix/suffix (more specific than general etc.clientlibs)
    /\/etc\.clientlibs\/[^"']+\.lc-[a-f0-9]+-lc\.min\.(js|css)/i,
    // Modern libs clientlib paths
    /\/libs\.clientlibs\//i,
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
    // AMS-specific clientlib pattern with fingerprinted hashes (both JS and CSS)
    /\/etc\.clientlibs\/[^"']+\.min\.[a-f0-9]{32}\.(js|css)/i,
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
  
  // Only give CS weight for core components, but reduced since they can exist in AMS too
  if (normalizedHtml.match(/class="[^"]*cmp-[^"]*"/)) {
    csMatches += 1; // Reduced weight since core components can exist in both AMS and CS
  }
  
  if (normalizedHtml.includes('/etc/designs/') || normalizedHtml.includes('foundation-')) {
    amsMatches += 2;
  }
  
  // Give extra weight to AMS clientlib format pattern as it's very distinctive
  if (/\/etc\.clientlibs\/[^"']+\.min\.[a-f0-9]{32}\.(js|css)/i.test(normalizedHtml)) {
    amsMatches += 5; // Increased weight since this is a very reliable AMS indicator
  }
  
  // Give extra weight to CS clientlib format pattern as it's very distinctive
  if (/\/etc\.clientlibs\/[^"']+\.lc-[a-f0-9]+-lc\.min\.(js|css)/i.test(normalizedHtml)) {
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