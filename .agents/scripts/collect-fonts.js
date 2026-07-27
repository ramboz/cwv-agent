// Browser-side script injected via page.evaluateOnNewDocument().
// Captures document.fonts descriptors and representative computed font stacks.
(function () {
  if (typeof window === 'undefined') return;

  const FONT_READY_TIMEOUT_MS = 1000;
  const TEXT_SELECTORS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'p', 'button', 'a'];

  function cleanString(value) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    if (!s) return null;
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === '\'' && s[s.length - 1] === '\'')) {
      return s.slice(1, -1);
    }
    return s;
  }

  function plainFace(face) {
    return {
      family: cleanString(face && face.family),
      style: cleanString(face && face.style),
      weight: cleanString(face && face.weight),
      stretch: cleanString(face && face.stretch),
      display: cleanString(face && face.display),
      unicodeRange: cleanString(face && face.unicodeRange),
      featureSettings: cleanString(face && face.featureSettings),
      ascentOverride: cleanString(face && face.ascentOverride),
      descentOverride: cleanString(face && face.descentOverride),
      lineGapOverride: cleanString(face && face.lineGapOverride),
      sizeAdjust: cleanString(face && face.sizeAdjust),
      status: cleanString(face && face.status),
    };
  }

  function isSwapRisk(face) {
    const display = face && face.display ? String(face.display).trim().toLowerCase() : '';
    return display === '' || display === 'auto' || display === 'swap';
  }

  function collectUsedFonts() {
    const used = {};
    if (typeof document === 'undefined' || !document.querySelector) return used;
    for (let i = 0; i < TEXT_SELECTORS.length; i++) {
      const selector = TEXT_SELECTORS[i];
      used[selector] = null;
      try {
        const el = selector === 'body' ? (document.body || document.querySelector('body')) : document.querySelector(selector);
        if (!el || typeof getComputedStyle !== 'function') continue;
        used[selector] = cleanString(getComputedStyle(el).fontFamily);
      } catch { /* keep null */ }
    }
    return used;
  }

  function emptySnapshot() {
    return {
      count: 0,
      loaded: 0,
      swapRisk: 0,
      faces: [],
      usedFonts: collectUsedFonts(),
    };
  }

  function waitWithTimeout(promise, ms) {
    if (!promise || typeof promise.then !== 'function') return Promise.resolve();
    return new Promise(function (resolve) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve('timeout');
      }, ms);
      promise.then(function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve('ready');
      }, function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve('error');
      });
    });
  }

  window.__fonts_snapshot = async function () {
    const usedFonts = collectUsedFonts();
    try {
      if (typeof document === 'undefined' || !document.fonts) return emptySnapshot();
      await waitWithTimeout(document.fonts.ready, FONT_READY_TIMEOUT_MS);

      let faces = [];
      try {
        faces = Array.from(document.fonts).map(plainFace);
      } catch {
        faces = [];
      }
      let loaded = 0;
      let swapRisk = 0;
      for (let i = 0; i < faces.length; i++) {
        if (faces[i].status === 'loaded') loaded += 1;
        if (isSwapRisk(faces[i])) swapRisk += 1;
      }

      return {
        count: faces.length,
        loaded: loaded,
        swapRisk: swapRisk,
        faces: faces,
        usedFonts: usedFonts,
      };
    } catch {
      return emptySnapshot();
    }
  };
})();
