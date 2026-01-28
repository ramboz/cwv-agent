/**
 * CSS-to-CLS Attribution
 * Maps layout shifts to specific CSS rules and stylesheets
 */

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
      recommendation: 'Use font-display: swap with size-adjusted fallback font (size-adjust, ascent-override)',
      cssProperty: 'font-family',
      priority: 'high',
    };
  }

  // Dynamic content insertion (vertical shift)
  if (rectDiff.top > 10 && Math.abs(rectDiff.height) < 5) {
    return {
      type: 'content-insertion',
      description: `Element shifted down by ${rectDiff.top.toFixed(1)}px due to content inserted above`,
      recommendation: 'Reserve space for dynamic content with min-height, aspect-ratio, or skeleton screens',
      cssProperty: 'min-height',
      priority: 'high',
    };
  }

  // Image/media without dimensions (size change)
  if (Math.abs(rectDiff.width) > 10 || Math.abs(rectDiff.height) > 10) {
    return {
      type: 'unsized-media',
      description: `Element resized from ${source.previousRect.width.toFixed(0)}x${source.previousRect.height.toFixed(0)} to ${source.currentRect.width.toFixed(0)}x${source.currentRect.height.toFixed(0)}`,
      recommendation: 'Set explicit width/height attributes on images or use aspect-ratio CSS',
      cssProperty: 'aspect-ratio',
      priority: 'high',
    };
  }

  // Animation/transition (position change)
  if (Math.abs(rectDiff.left) > 5 || (Math.abs(rectDiff.top) > 5 && Math.abs(rectDiff.top) < 10)) {
    return {
      type: 'animation',
      description: `Element moved ${rectDiff.left.toFixed(1)}px horizontally and ${rectDiff.top.toFixed(1)}px vertically`,
      recommendation: 'Use transform instead of top/left for animations (composited properties)',
      cssProperty: 'transform',
      priority: 'medium',
    };
  }

  return {
    type: 'unknown',
    description: `Layout shift detected: width ${rectDiff.width.toFixed(1)}px, height ${rectDiff.height.toFixed(1)}px, top ${rectDiff.top.toFixed(1)}px, left ${rectDiff.left.toFixed(1)}px`,
    recommendation: 'Investigate computed style changes and dynamic content loading',
    priority: 'medium',
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
  if (!selector || !cause.cssProperty) {
    return null;
  }

  try {
    return await page.evaluate((sel, cssProperty) => {
      const element = document.querySelector(sel);
      if (!element) return null;

      // Get all stylesheets
      const stylesheets = Array.from(document.styleSheets);
      const results = [];

      for (const sheet of stylesheets) {
        try {
          const rules = Array.from(sheet.cssRules || []);

          for (const rule of rules) {
            if (rule.selectorText) {
              // Try to match selector (simplified matching)
              const selectorParts = sel.replace(/[#.]/g, ' ').trim().split(/\s+/);
              const ruleMatches = selectorParts.some(part =>
                rule.selectorText.includes(part)
              );

              if (ruleMatches && rule.style && rule.style[cssProperty]) {
                results.push({
                  href: sheet.href || 'inline',
                  selector: rule.selectorText,
                  property: cssProperty,
                  value: rule.style[cssProperty],
                });
              }
            }
          }
        } catch (e) {
          // Cross-origin stylesheet, skip
        }
      }

      // Return first match or null
      return results.length > 0 ? results[0] : null;
    }, selector, cause.cssProperty);
  } catch (e) {
    return null;
  }
}

/**
 * Attribute CLS to specific CSS rules
 * @param {Array} layoutShifts - Layout shift entries from Performance Observer
 * @param {Object} page - Puppeteer page instance
 * @returns {Array} Enhanced layout shift data with CSS attribution
 */
export async function attributeCLStoCSS(layoutShifts, page) {
  if (!layoutShifts || !Array.isArray(layoutShifts) || !page) {
    return [];
  }

  const enhancedShifts = [];

  for (const shift of layoutShifts) {
    if (!shift.sources || !Array.isArray(shift.sources)) {
      continue;
    }

    for (const source of shift.sources) {
      try {
        // Get element selector
        const elementInfo = await page.evaluate((sourceData) => {
          // Try to find element by node reference (if still exists)
          let element = null;

          // Fallback: try to find by position
          if (!element && sourceData.currentRect) {
            const rect = sourceData.currentRect;
            element = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2
            );
          }

          if (!element) return null;

          // Generate selector
          let selector = element.tagName.toLowerCase();
          if (element.id) {
            selector = `#${element.id}`;
          } else if (element.className && typeof element.className === 'string') {
            const classes = element.className.trim().split(/\s+/);
            if (classes.length > 0) {
              selector = `.${classes[0]}`;
            }
          }

          // Get computed styles
          const computed = window.getComputedStyle(element);
          return {
            selector,
            computedStyles: {
              position: computed.position,
              display: computed.display,
              width: computed.width,
              height: computed.height,
              marginTop: computed.marginTop,
              marginBottom: computed.marginBottom,
              fontFamily: computed.fontFamily,
              fontSize: computed.fontSize,
              transform: computed.transform,
            },
          };
        }, source);

        if (!elementInfo) {
          continue;
        }

        // Identify likely cause
        const cause = identifyShiftCause(source, elementInfo.computedStyles, shift.startTime);

        // Find stylesheet (with timeout protection)
        let stylesheet = null;
        try {
          const stylesheetPromise = findStylesheet(page, elementInfo.selector, cause);
          stylesheet = await Promise.race([
            stylesheetPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 1000)), // 1s timeout
          ]);
        } catch (e) {
          // Stylesheet lookup failed, continue without it
        }

        enhancedShifts.push({
          value: shift.value,
          startTime: shift.startTime,
          hadRecentInput: shift.hadRecentInput || false,
          element: elementInfo.selector,
          previousRect: source.previousRect,
          currentRect: source.currentRect,
          computedStyles: elementInfo.computedStyles,
          cause,
          stylesheet,
        });
      } catch (e) {
        // Skip this source if evaluation fails
        console.error('Error attributing CLS source:', e.message);
      }
    }
  }

  return enhancedShifts;
}

/**
 * Summarize CLS attribution for agent consumption
 * @param {Array} enhancedShifts - Enhanced shift data
 * @returns {Object} Summary
 */
export function summarizeCLSAttribution(enhancedShifts) {
  if (!enhancedShifts || !Array.isArray(enhancedShifts)) {
    return {
      totalShifts: 0,
      totalCLS: 0,
      byType: {},
      topIssues: [],
    };
  }

  const totalCLS = enhancedShifts.reduce((sum, shift) => sum + shift.value, 0);

  // Group by cause type
  const byType = enhancedShifts.reduce((acc, shift) => {
    const type = shift.cause?.type || 'unknown';
    if (!acc[type]) {
      acc[type] = {
        count: 0,
        totalValue: 0,
        elements: [],
      };
    }
    acc[type].count++;
    acc[type].totalValue += shift.value;
    acc[type].elements.push(shift.element);
    return acc;
  }, {});

  // Identify top issues (sorted by CLS value)
  const topIssues = enhancedShifts
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map(shift => ({
      element: shift.element,
      value: shift.value,
      type: shift.cause?.type,
      description: shift.cause?.description,
      recommendation: shift.cause?.recommendation,
      stylesheet: shift.stylesheet?.href,
      priority: shift.cause?.priority,
    }));

  return {
    totalShifts: enhancedShifts.length,
    totalCLS: parseFloat(totalCLS.toFixed(4)),
    byType,
    topIssues,
  };
}
