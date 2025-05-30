// JavaScript API Data Collection Functions
export async function setupCSPViolationTracking(page) {
  await page.evaluateOnNewDocument(() => {
    if (!window.CSP_VIOLATIONS) {
      window.CSP_VIOLATIONS = [];
      window.addEventListener('securitypolicyviolation', (e) => {
        window.CSP_VIOLATIONS.push({
          violatedDirective: e.violatedDirective,
          blockedURI: e.blockedURI,
          lineNumber: e.lineNumber,
          columnNumber: e.columnNumber,
          sourceFile: e.sourceFile,
          statusCode: e.statusCode,
          referrer: e.referrer,
          effectiveDirective: e.effectiveDirective
        });
      });
    }
  });
}

export async function collectJSApiData(page) {
  return await page.evaluate(async () => {
    const fontsSet = await document.fonts.ready;
    return {
      fonts: [...fontsSet].map((ff) => ({
        ascentOverride: ff.ascentOverride,
        descentOverride: ff.descentOverride,
        display: ff.display,
        family: ff.family,
        featureSettings: ff.featureSettings,
        lineGapOverride: ff.lineGapOverride,
        sizeAdjust: ff.sizeAdjust,
        status: ff.status,
        stretch: ff.stretch,
        style: ff.style,
        unicodeRange: ff.unicodeRange,
        variant: ff.variant,
        weight: ff.weight,
      })),
      usedFonts: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'p', 'button']
        .map((sel) => document.querySelector(sel))
        .filter((sel) => !!sel)
        .map((el) => el && window.getComputedStyle(el).fontFamily)
        .map((ff) => ff.split(',').map((f) => f.trim().replace(/['"]/g, '')))
        .reduce((set, val) => { set[val[0]] = []; val.splice(1).forEach((v) => set[val[0]].push(v)); return set; }, {}),
      cspViolations: window.CSP_VIOLATIONS || [],
    };
  }, { timeout: 30_000 });
} 