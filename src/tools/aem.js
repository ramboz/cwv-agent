/**
 * Detects the AEM implementation type from HTML source code and optionally HAR data
 * @param {object|Array} headers - HTTP headers or HAR entries
 * @param {string} htmlSource - The HTML source code of the page
 * @param {object} options - Optional parameters
 * @param {Array} options.harEntries - HAR log entries to analyze network requests
 * @return {string|null} - 'eds', 'cs', 'cs-spa', 'ams', 'aem-headless' or null if undetermined
 */
export function detectAEMVersion(headers, htmlSource, options = {}) {
  if (!htmlSource || typeof htmlSource !== 'string') {
    console.error('No HTML available. Cannot infer AEM version.');
    return null;
  }

  // Handle both JSON-structured HTML data and raw HTML strings
  let normalizedHtml = htmlSource.toLowerCase();
  let parsedHtmlData = null;

  // Check if htmlSource is JSON-structured data from extractCwvRelevantHtml
  if (htmlSource.trim().startsWith('{')) {
    try {
      parsedHtmlData = JSON.parse(htmlSource);
      // Keep the JSON string for regex matching but also parse for structured access
    } catch (e) {
      // Not JSON, treat as raw HTML
    }
  }

  // Check HAR entries for .model.json requests (runtime behavior)
  let hasModelJsonRequest = false;
  let modelJsonUrls = [];

  if (options.harEntries && Array.isArray(options.harEntries)) {
    for (const entry of options.harEntries) {
      const url = entry.request?.url || '';
      if (url.includes('.model.json')) {
        hasModelJsonRequest = true;
        modelJsonUrls.push(url);
      }
    }
  }

  // Check for SPA Editor patterns in HTML (static indicators)
  const spaPatterns = [
    /cq:pagemodel_root_url/i,       // Meta tag declaring model endpoint
    /<div[^>]+id=["']spa-root["']/i, // SPA root element
    /<div[^>]+id=["']root["'][^>]*><\/div>/i, // Generic root element (common in React)
    /clientlib-react/i,              // React framework
    /clientlib-angular/i,            // Angular framework
    /clientlib-vue/i,                // Vue framework
  ];

  let spaMatches = 0;
  for (const pattern of spaPatterns) {
    if (pattern.test(normalizedHtml)) {
      spaMatches++;
    }
  }

  // Decisive SPA indicators from HTML
  const hasSpaRootUrl = /cq:pagemodel_root_url/i.test(normalizedHtml);
  const hasModelJsonInHtml = /\.model\.json/i.test(normalizedHtml); // Meta tag reference
  const hasSpaRoot = /<div[^>]+id=["'](spa-root|root)["']/i.test(normalizedHtml);

  // Combined SPA detection: static HTML hints OR runtime network requests
  const isSpa = (hasSpaRootUrl || hasModelJsonInHtml || hasSpaRoot || hasModelJsonRequest || spaMatches >= 2);

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
    // RUM data-routing for EDS (both HTML attribute and JSON property formats)
    /data-routing="[^"]*eds=([^,"]*)/i,
    /"dataRouting":"[^"]*eds=([^,"]*)/i
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
    // RUM data-routing for CS (both HTML attribute and JSON property formats)
    /data-routing="[^"]*cs=([^,"]*)/i,
    /"dataRouting":"[^"]*cs=([^,"]*)/i
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
    // RUM data-routing for AMS (both HTML attribute and JSON property formats)
    /data-routing="[^"]*ams=([^,"]*)/i,
    /"dataRouting":"[^"]*ams=([^,"]*)/i
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

  // If we have parsed JSON structure, check data-routing directly
  if (parsedHtmlData?.head?.scripts) {
    for (const script of parsedHtmlData.head.scripts) {
      if (script.dataRouting) {
        const routing = script.dataRouting.toLowerCase();
        
        if (routing.includes('ams=')) {
          amsMatches += 5;
        }
        if (routing.includes('cs=')) {
          csMatches += 5;
        }
        if (routing.includes('eds=')) {
          edsMatches += 5;
        }
      }
    }
  }

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
  // Check both HTML attribute format and JSON property format
  if (/data-routing="[^"]*ams=([^,"]*)/i.test(normalizedHtml) || /"dataRouting":"[^"]*ams=([^,"]*)/i.test(normalizedHtml)) {
    amsMatches += 5;
  }

  if (/data-routing="[^"]*eds=([^,"]*)/i.test(normalizedHtml) || /"dataRouting":"[^"]*eds=([^,"]*)/i.test(normalizedHtml)) {
    edsMatches += 5;
  }

  if (/data-routing="[^"]*cs=([^,"]*)/i.test(normalizedHtml) || /"dataRouting":"[^"]*cs=([^,"]*)/i.test(normalizedHtml)) {
    csMatches += 5;
  }

  // Determine the most likely version based on match counts
  const maxMatches = Math.max(edsMatches, csMatches, amsMatches, aemHeadlessMatches);
  
  // Require a minimum threshold of matches to make a determination
  const MIN_THRESHOLD = 2;

  if (maxMatches < MIN_THRESHOLD) {
    return null;
  }

  // If SPA patterns are detected along with CS patterns, return cs-spa
  if (isSpa && csMatches > 0) {
    return 'cs-spa';
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