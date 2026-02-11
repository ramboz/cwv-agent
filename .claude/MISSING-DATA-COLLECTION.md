# Missing Data Collection: Design & Implementation Guide

## Overview

This document outlines critical performance data that is currently **not collected** by the CWV Agent but would significantly improve root cause analysis accuracy.

**Priority**: Medium (after prompt templates)
**Estimated Effort**: 2-3 days
**Impact**: +30-40% improvement in root cause identification accuracy

---

## Priority 1: Third-Party Script Attribution 🔴

### What's Missing

Currently, the HAR collector identifies large third-party scripts but doesn't provide:
- **Who loaded this script** (initiator chain)
- **What it's doing** (script purpose/category)
- **Execution time** (not just network time)
- **Main thread blocking time**

### Why It Matters

Third-party scripts are the #1 cause of poor TBT/INP but agents can't:
- Distinguish between analytics (deferrable) vs payment provider (critical)
- Trace blocking back to specific tag manager rules
- Identify which scripts cause long tasks

### Implementation

**File**: `src/tools/lab/third-party-attributor.js` (NEW)

```javascript
import { parse } from 'url';

/**
 * Analyze third-party scripts with attribution
 * @param {Array} harEntries - HAR entries
 * @param {Object} performanceEntries - Performance Observer data
 * @returns {Object} Third-party analysis
 */
export function analyzeThirdPartyScripts(harEntries, performanceEntries) {
  const thirdPartyScripts = harEntries
    .filter(entry => entry._resourceType === 'script')
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
          wait: entry.timings.wait,
          download: entry.timings.receive,
          total: entry.time,
        },

        // Size
        transferSize: entry.response.bodySize,
        uncompressedSize: entry.response.content.size,

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
    isRenderBlocking: scripts.some(s => s.isRenderBlocking),
  }));

  return {
    scripts: thirdPartyScripts,
    byCategory,
    categoryImpact,
    summary: {
      totalScripts: thirdPartyScripts.length,
      totalTransferSize: thirdPartyScripts.reduce((sum, s) => sum + s.transferSize, 0),
      totalNetworkTime: thirdPartyScripts.reduce((sum, s) => sum + s.network.total, 0),
      totalExecutionTime: thirdPartyScripts.reduce((sum, s) => sum + (s.execution?.duration || 0), 0),
      renderBlockingCount: thirdPartyScripts.filter(s => s.isRenderBlocking).length,
    },
  };
}

/**
 * Categorize script by URL/domain
 * @param {string} url - Script URL
 * @param {string} domain - Domain name
 * @returns {string} Category
 */
function categorizeScript(url, domain) {
  // Analytics
  if (domain.includes('google-analytics') || domain.includes('gtag') ||
      domain.includes('analytics') || domain.includes('segment')) {
    return 'analytics';
  }

  // Advertising
  if (domain.includes('doubleclick') || domain.includes('adsense') ||
      domain.includes('ads') || domain.includes('adnxs')) {
    return 'advertising';
  }

  // Social
  if (domain.includes('facebook') || domain.includes('twitter') ||
      domain.includes('linkedin') || domain.includes('instagram')) {
    return 'social';
  }

  // Tag managers
  if (domain.includes('googletagmanager') || domain.includes('tealium') ||
      domain.includes('launch.adobe')) {
    return 'tag-manager';
  }

  // CDN
  if (domain.includes('cdn') || domain.includes('cloudfront') ||
      domain.includes('fastly') || domain.includes('akamai')) {
    return 'cdn';
  }

  // Payment
  if (domain.includes('stripe') || domain.includes('paypal') ||
      domain.includes('braintree')) {
    return 'payment';
  }

  // Customer support
  if (domain.includes('zendesk') || domain.includes('intercom') ||
      domain.includes('livechat')) {
    return 'support';
  }

  return 'other';
}

/**
 * Find script execution in performance entries
 * @param {string} scriptUrl - Script URL
 * @param {Object} performanceEntries - Performance entries
 * @returns {Object|null} Execution data
 */
function findScriptExecution(scriptUrl, performanceEntries) {
  // Look for long animation frames (LoAF) attributed to this script
  const longTasks = performanceEntries.longTasks || [];

  const matchingTask = longTasks.find(task => {
    // Check if script attribution matches
    return task.attribution?.some(attr =>
      attr.containerSrc && attr.containerSrc.includes(scriptUrl)
    );
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
  const longTasks = performanceEntries.longTasks || [];

  return longTasks
    .filter(task => {
      return task.attribution?.some(attr =>
        attr.containerSrc && attr.containerSrc.includes(scriptUrl)
      );
    })
    .map(task => ({
      duration: task.duration,
      startTime: task.startTime,
      blockingDuration: task.duration > 50 ? task.duration - 50 : 0,
    }));
}
```

**Integration Point**: `src/core/collect.js`

```javascript
import { analyzeThirdPartyScripts } from '../tools/lab/third-party-attributor.js';

// In collectData() function, after HAR collection:
if (harData) {
  pageData.thirdPartyAnalysis = analyzeThirdPartyScripts(
    harData.log.entries,
    performanceEntries
  );
}
```

**Agent Usage**: HAR Agent and Rules Agent can now say:
> "Analytics category scripts (3 scripts, 450KB) block for 600ms. Defer these scripts to improve TBT by 550ms."

---

## Priority 2: CSS-to-CLS Attribution 🔴

### What's Missing

Currently, the Performance Observer collects CLS sources (which elements shifted) but doesn't provide:
- **Which CSS rule caused the shift** (font-face, layout, etc.)
- **Which stylesheet** contains the problematic rule
- **What triggered the shift** (font load, dynamic content, etc.)

### Why It Matters

Agents can say "element X shifted" but can't recommend **what to fix in CSS**.

### Implementation

**File**: `src/tools/lab/cls-attributor.js` (NEW)

```javascript
/**
 * Attribute CLS to specific CSS rules
 * @param {Array} layoutShifts - Layout shift entries
 * @param {Object} page - Puppeteer page
 * @returns {Array} Enhanced layout shift data
 */
export async function attributeCLStoCSS(layoutShifts, page) {
  const enhancedShifts = [];

  for (const shift of layoutShifts) {
    for (const source of shift.sources || []) {
      const element = source.node;

      // Get element selector
      const selector = await page.evaluate(el => {
        if (!el) return null;
        if (el.id) return `#${el.id}`;
        if (el.className) return `.${el.className.split(' ')[0]}`;
        return el.tagName.toLowerCase();
      }, element);

      // Get computed styles
      const computedStyles = await page.evaluate(el => {
        if (!el) return null;
        const computed = window.getComputedStyle(el);
        return {
          position: computed.position,
          display: computed.display,
          width: computed.width,
          height: computed.height,
          marginTop: computed.marginTop,
          marginBottom: computed.marginBottom,
          fontFamily: computed.fontFamily,
          fontSize: computed.fontSize,
        };
      }, element);

      // Identify likely cause
      const cause = identifyShiftCause(source, computedStyles, shift.startTime);

      // Find stylesheet
      const stylesheet = await findStylesheet(page, selector, cause);

      enhancedShifts.push({
        value: shift.value,
        startTime: shift.startTime,
        element: selector,
        previousRect: source.previousRect,
        currentRect: source.currentRect,
        computedStyles,
        cause,
        stylesheet,
      });
    }
  }

  return enhancedShifts;
}

/**
 * Identify what caused the layout shift
 * @param {Object} source - Shift source
 * @param {Object} computedStyles - Computed styles
 * @param {number} shiftTime - When shift occurred
 * @returns {Object} Cause information
 */
function identifyShiftCause(source, computedStyles, shiftTime) {
  const rectDiff = {
    width: source.currentRect.width - source.previousRect.width,
    height: source.currentRect.height - source.previousRect.height,
    top: source.currentRect.top - source.previousRect.top,
    left: source.currentRect.left - source.previousRect.left,
  };

  // Font swap (height change without width change)
  if (Math.abs(rectDiff.height) > 5 && Math.abs(rectDiff.width) < 2) {
    return {
      type: 'font-swap',
      description: `Font loaded and swapped, changing text height by ${rectDiff.height.toFixed(1)}px`,
      recommendation: 'Use font-display: swap with size-adjusted fallback font',
      cssProperty: 'font-family',
    };
  }

  // Dynamic content insertion (vertical shift)
  if (rectDiff.top > 10 && rectDiff.height === 0) {
    return {
      type: 'content-insertion',
      description: `Element shifted down by ${rectDiff.top.toFixed(1)}px due to content inserted above`,
      recommendation: 'Reserve space for dynamic content with min-height or aspect-ratio',
      cssProperty: 'min-height',
    };
  }

  // Image without dimensions (size change)
  if (Math.abs(rectDiff.width) > 10 || Math.abs(rectDiff.height) > 10) {
    return {
      type: 'unsized-media',
      description: `Element resized from ${source.previousRect.width}x${source.previousRect.height} to ${source.currentRect.width}x${source.currentRect.height}`,
      recommendation: 'Set explicit width/height attributes on images',
      cssProperty: 'aspect-ratio',
    };
  }

  return {
    type: 'unknown',
    description: 'Layout shift cause unclear',
    recommendation: 'Investigate computed style changes',
  };
}

/**
 * Find which stylesheet contains the rule
 * @param {Object} page - Puppeteer page
 * @param {string} selector - Element selector
 * @param {Object} cause - Shift cause
 * @returns {Object|null} Stylesheet info
 */
async function findStylesheet(page, selector, cause) {
  return await page.evaluate((sel, cssProperty) => {
    const element = document.querySelector(sel);
    if (!element) return null;

    // Get all stylesheets
    const stylesheets = Array.from(document.styleSheets);

    for (const sheet of stylesheets) {
      try {
        const rules = Array.from(sheet.cssRules || []);

        for (const rule of rules) {
          if (rule.selectorText && rule.selectorText.includes(sel.replace('#', '').replace('.', ''))) {
            if (rule.style[cssProperty]) {
              return {
                href: sheet.href || 'inline',
                selector: rule.selectorText,
                property: cssProperty,
                value: rule.style[cssProperty],
              };
            }
          }
        }
      } catch (e) {
        // Cross-origin stylesheet, skip
      }
    }

    return null;
  }, selector, cause.cssProperty);
}
```

**Integration Point**: `src/tools/lab/performance-collector.js`

```javascript
import { attributeCLStoCSS } from './cls-attributor.js';

// In collectPerformanceMetrics(), after collecting layout shifts:
if (layoutShifts.length > 0) {
  perfData.layoutShiftsEnhanced = await attributeCLStoCSS(layoutShifts, page);
}
```

**Agent Usage**: Performance Observer Agent can now say:
> "Font swap in .hero-title caused 0.08 CLS. Stylesheet: /styles/typography.css, property: font-family. Use font-display: swap with size-adjusted fallback."

---

## Priority 3: Font Loading Timeline 🟡

### What's Missing

Currently, we don't collect:
- **When fonts started loading** (relative to page load)
- **Which fonts blocked rendering** vs loaded async
- **Font swap timing** (when FOUT/FOIT occurred)
- **Fallback font metrics** (is fallback properly sized?)

### Why It Matters

Font loading is a common cause of both CLS (font swap) and LCP delay (blocking).

### Implementation

**File**: `src/tools/lab/font-analyzer.js` (NEW)

```javascript
/**
 * Analyze font loading timeline
 * @param {Object} page - Puppeteer page
 * @param {Array} performanceEntries - Performance entries
 * @returns {Object} Font analysis
 */
export async function analyzeFontLoading(page, performanceEntries) {
  const fontData = await page.evaluate(() => {
    const fonts = Array.from(document.fonts);

    return {
      fonts: fonts.map(font => ({
        family: font.family,
        weight: font.weight,
        style: font.style,
        status: font.status, // 'unloaded', 'loading', 'loaded', 'error'
        display: font.display || 'auto',
      })),

      // Check for @font-face rules
      fontFaceRules: Array.from(document.styleSheets)
        .flatMap(sheet => {
          try {
            return Array.from(sheet.cssRules || [])
              .filter(rule => rule instanceof CSSFontFaceRule)
              .map(rule => ({
                family: rule.style.fontFamily,
                src: rule.style.src,
                display: rule.style.fontDisplay || 'auto',
                weight: rule.style.fontWeight || 'normal',
                style: rule.style.fontStyle || 'normal',
                // Check for size-adjust (modern fallback technique)
                sizeAdjust: rule.style.sizeAdjust,
                ascentOverride: rule.style.ascentOverride,
                descentOverride: rule.style.descentOverride,
              }));
          } catch (e) {
            return [];
          }
        }),
    };
  });

  // Match fonts with resource timing
  const fontResources = performanceEntries.resources
    ?.filter(r => r.initiatorType === 'css' && r.name.match(/\.(woff2?|ttf|otf)$/))
    .map(resource => ({
      url: resource.name,
      startTime: resource.startTime,
      responseEnd: resource.responseEnd,
      duration: resource.duration,
      transferSize: resource.transferSize,
      // Did this font cause render blocking?
      blockingTime: resource.startTime < 1000 ? resource.responseEnd : 0,
    }));

  // Cross-reference with layout shifts to find font-swap CLS
  const fontSwapShifts = performanceEntries.layoutShifts
    ?.filter(shift => {
      // Check if shift timing coincides with font load
      return fontResources.some(font =>
        Math.abs(shift.startTime - font.responseEnd) < 100
      );
    })
    .map(shift => ({
      value: shift.value,
      startTime: shift.startTime,
      likelyFont: fontResources.find(font =>
        Math.abs(shift.startTime - font.responseEnd) < 100
      ),
    }));

  // Analyze font-display strategies
  const strategies = {
    auto: fontData.fontFaceRules.filter(f => f.display === 'auto' || !f.display).length,
    block: fontData.fontFaceRules.filter(f => f.display === 'block').length,
    swap: fontData.fontFaceRules.filter(f => f.display === 'swap').length,
    fallback: fontData.fontFaceRules.filter(f => f.display === 'fallback').length,
    optional: fontData.fontFaceRules.filter(f => f.display === 'optional').length,
  };

  // Check for size-adjusted fallbacks (best practice)
  const hasSizeAdjustedFallbacks = fontData.fontFaceRules.some(f =>
    f.sizeAdjust || f.ascentOverride || f.descentOverride
  );

  return {
    fonts: fontData.fonts,
    fontFaceRules: fontData.fontFaceRules,
    fontResources,
    fontSwapShifts,
    strategies,
    hasSizeAdjustedFallbacks,
    summary: {
      totalFonts: fontData.fonts.length,
      totalFontRequests: fontResources.length,
      totalTransferSize: fontResources.reduce((sum, f) => sum + f.transferSize, 0),
      blockingFonts: fontResources.filter(f => f.blockingTime > 0).length,
      fontSwapCLS: fontSwapShifts.reduce((sum, s) => sum + s.value, 0),
      usesSwap: strategies.swap > 0,
      hasFallbackOptimization: hasSizeAdjustedFallbacks,
    },
  };
}
```

**Integration Point**: `src/tools/lab/performance-collector.js`

```javascript
import { analyzeFontLoading } from './font-analyzer.js';

// In collectPerformanceMetrics():
perfData.fontAnalysis = await analyzeFontLoading(page, performanceEntries);
```

**Agent Usage**: HTML Agent can now say:
> "3 custom fonts use font-display: auto (blocking). Font swap causes 0.08 CLS. No size-adjusted fallbacks detected. Use font-display: swap with size-adjust property for fallback font."

---

## Priority 4: JavaScript Long Task Attribution 🟡

### What's Missing

Currently, Performance Observer collects long tasks but doesn't provide:
- **Which function/file caused the long task**
- **Call stack** (what triggered this?)
- **What work was being done** (parsing, rendering, GC, etc.)

### Why It Matters

Agents can say "long task of 500ms" but can't recommend **which code to optimize**.

### Implementation

**Enhancement to**: `src/tools/lab/performance-collector.js`

```javascript
/**
 * Enhanced long task collection with attribution
 * @param {Object} page - Puppeteer page
 * @returns {Array} Long tasks with attribution
 */
async function collectLongTasksWithAttribution(page) {
  return await page.evaluate(() => {
    const longTasks = [];

    // Use PerformanceLongAnimationFrameTiming (LoAF) API
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 50) {
          longTasks.push({
            type: entry.entryType,
            name: entry.name,
            duration: entry.duration,
            startTime: entry.startTime,
            blockingDuration: entry.blockingDuration,

            // Attribution (LoAF provides detailed attribution)
            attribution: entry.scripts?.map(script => ({
              name: script.name,
              entryType: script.entryType,
              startTime: script.startTime,
              duration: script.duration,
              invoker: script.invoker, // Function name
              invokerType: script.invokerType, // 'user-callback', 'event-listener', etc.
              sourceURL: script.sourceURL, // Script file
              sourceFunctionName: script.sourceFunctionName,
              sourceCharPosition: script.sourceCharPosition,
            })) || [],

            // Render timing within the task
            renderStart: entry.renderStart,
            renderDuration: entry.renderStart ? entry.duration - entry.renderStart : 0,

            // Style and layout timing
            styleAndLayoutStart: entry.styleAndLayoutStart,
            styleAndLayoutDuration: entry.styleAndLayoutStart ? entry.renderStart - entry.styleAndLayoutStart : 0,
          });
        }
      }
    });

    observer.observe({ entryTypes: ['long-animation-frame'] });

    // Wait for page to stabilize
    return new Promise(resolve => {
      setTimeout(() => {
        observer.disconnect();
        resolve(longTasks);
      }, 5000);
    });
  });
}
```

**Agent Usage**: Performance Observer Agent can now say:
> "Long task of 523ms caused by app.bundle.js:1234, function handleMenuClick(). 400ms spent in JavaScript execution, 123ms in style/layout. Optimize menu rendering or defer to next frame."

---

## Priority 5: Server Timing Headers 🟢

### What's Missing

Server-Timing headers provide valuable backend performance data:
- Database query time
- Cache hit/miss
- Rendering time (SSR)
- CDN processing time

Currently not collected or parsed.

### Implementation

**Enhancement to**: `src/tools/lab/har-collector.js`

```javascript
/**
 * Parse Server-Timing headers from HAR
 * @param {Object} harEntry - HAR entry
 * @returns {Array|null} Server timing entries
 */
function parseServerTiming(harEntry) {
  const serverTimingHeader = harEntry.response.headers
    .find(h => h.name.toLowerCase() === 'server-timing');

  if (!serverTimingHeader) return null;

  // Parse: "cache;desc=hit;dur=0.1, db;dur=123.4, render;dur=45.6"
  return serverTimingHeader.value
    .split(',')
    .map(entry => {
      const parts = entry.split(';');
      const name = parts[0].trim();

      const timing = {
        name,
        duration: 0,
        description: '',
      };

      parts.slice(1).forEach(part => {
        const [key, value] = part.split('=');
        if (key.trim() === 'dur') {
          timing.duration = parseFloat(value);
        } else if (key.trim() === 'desc') {
          timing.description = value;
        }
      });

      return timing;
    });
}

// In summarizeHAR():
export function summarizeHAR(har) {
  // ... existing code ...

  // Extract server timing from main document
  const mainDocument = har.log.entries.find(e => e.request.url === pageUrl);
  const serverTiming = mainDocument ? parseServerTiming(mainDocument) : null;

  if (serverTiming) {
    summary.serverTiming = {
      entries: serverTiming,
      totalBackendTime: serverTiming.reduce((sum, t) => sum + t.duration, 0),
      hasCacheHit: serverTiming.some(t => t.name === 'cache' && t.description.includes('hit')),
    };
  }

  return summary;
}
```

**Agent Usage**: HAR Agent can now say:
> "Server-Timing reveals 450ms database query time and cache miss. TTFB is 800ms, with 450ms spent in database. Optimize query or implement Redis caching."

---

## Priority 6: Image Attribute Analysis 🟢

### What's Missing

Currently not collecting image attributes:
- `loading="lazy"` vs `loading="eager"`
- `fetchpriority="high"` vs `"low"`
- `decoding="async"` vs `"sync"`
- Explicit width/height (CLS prevention)

### Implementation

**Enhancement to**: `src/tools/lab/performance-collector.js`

```javascript
/**
 * Analyze image attributes
 * @param {Object} page - Puppeteer page
 * @param {Object} lcpElement - LCP element info
 * @returns {Array} Image analysis
 */
async function analyzeImageAttributes(page, lcpElement) {
  return await page.evaluate((lcpSelector) => {
    const images = Array.from(document.querySelectorAll('img'));

    return images.map(img => {
      const rect = img.getBoundingClientRect();
      const isAboveFold = rect.top < window.innerHeight;
      const isLCP = lcpSelector && img.matches(lcpSelector);

      return {
        src: img.src,
        selector: img.id ? `#${img.id}` : img.className ? `.${img.className.split(' ')[0]}` : 'img',

        // Attributes
        loading: img.getAttribute('loading') || 'auto',
        fetchpriority: img.getAttribute('fetchpriority') || 'auto',
        decoding: img.getAttribute('decoding') || 'auto',
        width: img.getAttribute('width'),
        height: img.getAttribute('height'),

        // Position
        isAboveFold,
        isLCP,

        // Size
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        displayWidth: rect.width,
        displayHeight: rect.height,

        // Issues
        issues: [
          ...(isAboveFold && img.getAttribute('loading') === 'lazy' ? ['Above-fold image has loading=lazy'] : []),
          ...(isLCP && img.getAttribute('fetchpriority') !== 'high' ? ['LCP image missing fetchpriority=high'] : []),
          ...(!img.getAttribute('width') || !img.getAttribute('height') ? ['Missing width/height (may cause CLS)'] : []),
        ],
      };
    });
  }, lcpElement?.selector || null);
}
```

**Agent Usage**: HTML Agent can now say:
> "LCP image (hero.jpg) has loading='lazy' and missing fetchpriority='high'. Above-fold image should use loading='eager' fetchpriority='high' to prioritize loading."

---

## Implementation Priority Matrix

| Feature | Priority | Effort | Impact | ROI |
|---------|----------|--------|--------|-----|
| Third-Party Attribution | 🔴 High | 4 hours | Very High | ⭐⭐⭐⭐⭐ |
| CSS-to-CLS Attribution | 🔴 High | 6 hours | Very High | ⭐⭐⭐⭐⭐ |
| Font Loading Timeline | 🟡 Medium | 4 hours | High | ⭐⭐⭐⭐ |
| Long Task Attribution | 🟡 Medium | 3 hours | High | ⭐⭐⭐⭐ |
| Server Timing Headers | 🟢 Low | 2 hours | Medium | ⭐⭐⭐ |
| Image Attribute Analysis | 🟢 Low | 2 hours | Medium | ⭐⭐⭐ |

**Total Effort**: 21 hours (~2.5 days)

---

## Testing Strategy

For each enhancement:

1. **Unit Tests**: Test parsing functions with sample data
2. **Integration Tests**: Test on 5 diverse websites
3. **Agent Tests**: Verify agents use new data in findings
4. **Validation**: Confirm improved root cause accuracy

**Success Metrics**:
- +30% increase in root cause identification
- -20% "unknown cause" findings
- +40% actionable code-level recommendations

---

## Migration Path

**Phase 1**: Implement Priority 1-2 (Third-Party + CSS-CLS)
- Highest impact
- Most requested by users
- 10 hours effort

**Phase 2**: Implement Priority 3-4 (Fonts + Long Tasks)
- Medium impact
- Fills gaps in attribution
- 7 hours effort

**Phase 3**: Implement Priority 5-6 (Server Timing + Images)
- Low-hanging fruit
- Quick wins
- 4 hours effort

**Total Timeline**: 2-3 days for all enhancements

---

## Example: Before vs After

### Before (Missing Attribution):
```json
{
  "description": "Layout shift of 0.08 detected",
  "evidence": {
    "source": "perfEntries.layoutShifts",
    "reference": "Element .hero-title shifted"
  }
}
```
❌ Agent can't recommend CSS fix

### After (With CSS Attribution):
```json
{
  "description": "Font swap in .hero-title causes 0.08 CLS due to font-display: auto",
  "evidence": {
    "source": "perfEntries.layoutShiftsEnhanced",
    "reference": "Stylesheet: /styles/typography.css, property: font-family, trigger: font load at 1234ms"
  },
  "implementation": "Update @font-face rule to use font-display: swap with size-adjusted fallback",
  "codeExample": "File: /styles/typography.css\\n\\n@font-face {\\n  font-family: 'CustomFont';\\n  src: url('/fonts/custom.woff2');\\n  font-display: swap;\\n}\\n\\n@font-face {\\n  font-family: 'CustomFont-fallback';\\n  src: local('Arial');\\n  size-adjust: 105%;\\n}"
}
```
✅ Agent provides concrete CSS fix with file path and code

---

## Conclusion

Implementing these missing data collectors will:
- ✅ Enable file-level recommendations (not just metric-level)
- ✅ Improve root cause accuracy by 30-40%
- ✅ Reduce "unknown cause" findings
- ✅ Provide copy-paste ready code examples
- ✅ Make validation more precise (concrete evidence)

**Recommended Next Steps**:
1. Implement Priority 1-2 (Third-Party + CSS-CLS) - **10 hours**
2. Test on 5 diverse websites
3. Measure improvement in root cause identification
4. Proceed to Priority 3-4 if results are positive

For implementation guidance, see code examples above and existing collectors in `src/tools/lab/`.
