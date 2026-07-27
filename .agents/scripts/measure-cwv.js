// Browser-side script injected via page.evaluateOnNewDocument().
// The launcher prepends vendor/web-vitals.attribution.iife.js so the `webVitals` global is available.
//
// Captures two complementary layers:
//   1. web-vitals v4 attribution — canonical p75-style summary values (LCP/CLS/INP/FCP/TTFB)
//      with attribution phases. Latest-value-wins; snapshot pulled after the launcher
//      dispatches visibilitychange->hidden so web-vitals commits final LCP/CLS.
//   2. Raw PerformanceObserver event logs for layout-shift and event entries. Full arrays,
//      not just the worst. Lets downstream analyzers prioritize by impact across ALL
//      shifts and ALL interactions in the session — useful for fixing many issues at once.
(function () {
  if (typeof window === 'undefined') return;

  // Soft cap to keep arrays serializable on very chatty pages.
  const MAX_SHIFTS = 200;
  const MAX_INTERACTIONS = 200;
  const MAX_MAIN_THREAD_ENTRIES = 200;
  const MAX_LOAF_SCRIPTS = 20;
  const MAX_CSP_VIOLATIONS = 50;
  // PerformanceObserver default for 'event' is 104ms; spec-recommended "slow" threshold is 40ms.
  const EVENT_DURATION_THRESHOLD = 40;

  // -------------------------------------------------------------------------
  // Selector generation for Node references pulled from raw PerformanceEntry.
  // -------------------------------------------------------------------------
  function nodeToSelector(node) {
    if (!node || node.nodeType !== 1) return null;
    const parts = [];
    let el = node;
    let depth = 0;
    while (el && el.nodeType === 1 && depth < 5) {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (!tag) break;
      let piece = tag;
      if (el.id) {
        parts.unshift(tag + '#' + el.id);
        break; // ids are unique enough to stop walking
      }
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\s+/).slice(0, 2).filter(Boolean);
        if (cls.length) piece += '.' + cls.join('.');
      }
      parts.unshift(piece);
      el = el.parentElement;
      depth += 1;
    }
    return parts.join(' > ') || null;
  }

  function plainRect(r) {
    if (!r) return null;
    return {
      x: Math.round(r.x || 0),
      y: Math.round(r.y || 0),
      width: Math.round(r.width || 0),
      height: Math.round(r.height || 0),
    };
  }

  // -------------------------------------------------------------------------
  // Event-log state
  // -------------------------------------------------------------------------
  const shifts = [];
  const interactionsById = new Map();
  const loafEntries = [];
  const longTaskEntries = [];
  const cspViolations = [];

  function nullableString(value) {
    return (typeof value === 'string' && value) ? value : null;
  }

  function nullableNumber(value) {
    return (typeof value === 'number' && isFinite(value)) ? Math.round(value) : null;
  }

  function recordCspViolation(event) {
    if (cspViolations.length >= MAX_CSP_VIOLATIONS) return;
    event = event || {};
    cspViolations.push({
      violatedDirective: nullableString(event.violatedDirective),
      effectiveDirective: nullableString(event.effectiveDirective),
      blockedURI: nullableString(event.blockedURI),
      sourceFile: nullableString(event.sourceFile),
      lineNumber: nullableNumber(event.lineNumber),
      columnNumber: nullableNumber(event.columnNumber),
      disposition: nullableString(event.disposition),
    });
  }

  function recordLayoutShift(entry) {
    if (shifts.length >= MAX_SHIFTS) return;
    const sources = [];
    const entrySources = entry.sources || [];
    for (let i = 0; i < entrySources.length; i += 1) {
      const s = entrySources[i];
      if (!s) continue;
      sources.push({
        target: nodeToSelector(s.node),
        previousRect: plainRect(s.previousRect),
        currentRect: plainRect(s.currentRect),
      });
    }
    shifts.push({
      value: entry.value,
      startTime: Math.round(entry.startTime || 0),
      hadRecentInput: !!entry.hadRecentInput,
      sources: sources,
    });
  }

  function recordEventTiming(entry) {
    // Non-interaction events have interactionId === 0. Skip them: they don't contribute to INP.
    if (!entry.interactionId) return;
    const prev = interactionsById.get(entry.interactionId);
    const duration = entry.duration || 0;
    const target = nodeToSelector(entry.target);
    if (!prev) {
      if (interactionsById.size >= MAX_INTERACTIONS) return;
      interactionsById.set(entry.interactionId, {
        interactionId: entry.interactionId,
        name: entry.name,
        target: target,
        duration: duration,
        startTime: Math.round(entry.startTime || 0),
        processingStart: Math.round(entry.processingStart || 0),
        processingEnd: Math.round(entry.processingEnd || 0),
        entryCount: 1,
      });
      return;
    }
    // Same interaction id — keep the worst-duration entry's fields (that's what drives INP),
    // but extend processingEnd and bump the entry count.
    prev.entryCount += 1;
    if (duration > prev.duration) {
      prev.duration = duration;
      prev.name = entry.name;
      if (target) prev.target = target;
      prev.processingStart = Math.round(entry.processingStart || 0);
    }
    prev.processingEnd = Math.max(prev.processingEnd, Math.round(entry.processingEnd || 0));
    prev.startTime = Math.min(prev.startTime, Math.round(entry.startTime || 0));
  }

  function roundedNumber(value) {
    return (typeof value === 'number' && isFinite(value)) ? Math.round(value) : 0;
  }

  function plainLoafScript(script) {
    script = script || {};
    return {
      sourceURL: script.sourceURL || null,
      sourceFunctionName: script.sourceFunctionName || null,
      invoker: script.invoker || null,
      invokerType: script.invokerType || null,
      duration: roundedNumber(script.duration),
      forcedStyleAndLayoutDuration: roundedNumber(script.forcedStyleAndLayoutDuration),
      pauseDuration: roundedNumber(script.pauseDuration),
    };
  }

  function recordLongAnimationFrame(entry) {
    if (loafEntries.length >= MAX_MAIN_THREAD_ENTRIES) return;
    const scripts = [];
    const entryScripts = entry && entry.scripts;
    if (entryScripts && typeof entryScripts.length === 'number') {
      for (let i = 0; i < entryScripts.length && i < MAX_LOAF_SCRIPTS; i += 1) {
        scripts.push(plainLoafScript(entryScripts[i]));
      }
    }
    loafEntries.push({
      startTime: roundedNumber(entry && entry.startTime),
      duration: roundedNumber(entry && entry.duration),
      renderStart: roundedNumber(entry && entry.renderStart),
      styleAndLayoutStart: roundedNumber(entry && entry.styleAndLayoutStart),
      blockingDuration: roundedNumber(entry && entry.blockingDuration),
      scripts: scripts,
    });
  }

  function plainTaskAttribution(attr) {
    attr = attr || {};
    return {
      name: attr.name || null,
      entryType: attr.entryType || null,
      containerType: attr.containerType || null,
      containerName: attr.containerName || null,
      containerSrc: attr.containerSrc || null,
    };
  }

  function recordLongTask(entry) {
    if (longTaskEntries.length >= MAX_MAIN_THREAD_ENTRIES) return;
    const attribution = [];
    const entryAttribution = entry && entry.attribution;
    if (entryAttribution && typeof entryAttribution.length === 'number') {
      for (let i = 0; i < entryAttribution.length; i += 1) {
        attribution.push(plainTaskAttribution(entryAttribution[i]));
      }
    }
    longTaskEntries.push({
      startTime: roundedNumber(entry && entry.startTime),
      duration: roundedNumber(entry && entry.duration),
      attribution: attribution,
    });
  }

  function mainThreadSnapshot() {
    return {
      loaf: loafEntries.slice(),
      longTasks: longTaskEntries.slice(),
    };
  }

  // Register raw PerformanceObservers before anything else runs on the page.
  // buffered:true picks up entries that fired between navigation start and observer creation.
  try {
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('securitypolicyviolation', recordCspViolation);
    }
  } catch { /* CSP capture must never break measurement */ }

  if (typeof PerformanceObserver === 'function') {
    try {
      const shiftObs = new PerformanceObserver(function (list) {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i += 1) recordLayoutShift(entries[i]);
      });
      shiftObs.observe({ type: 'layout-shift', buffered: true });
    } catch { /* unsupported — fall back to web-vitals attribution only */ }

    try {
      const eventObs = new PerformanceObserver(function (list) {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i += 1) recordEventTiming(entries[i]);
      });
      eventObs.observe({
        type: 'event',
        buffered: true,
        durationThreshold: EVENT_DURATION_THRESHOLD,
      });
    } catch { /* older Chrome without durationThreshold — ignore */ }

    try {
      const loafObs = new PerformanceObserver(function (list) {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i += 1) recordLongAnimationFrame(entries[i]);
      });
      loafObs.observe({ type: 'long-animation-frame', buffered: true });
    } catch { /* older Chrome without LoAF — longtask still captures coarse blocking */ }

    try {
      const longTaskObs = new PerformanceObserver(function (list) {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i += 1) recordLongTask(entries[i]);
      });
      longTaskObs.observe({ type: 'longtask', buffered: true });
    } catch { /* unsupported — omit coarse main-thread evidence */ }
  }

  // -------------------------------------------------------------------------
  // web-vitals summary layer
  // -------------------------------------------------------------------------
  if (typeof webVitals === 'undefined') {
    // Launcher forgot to prepend the IIFE. Still define the snapshot so calls don't throw,
    // and still expose the raw event logs (which don't depend on web-vitals).
    window.__cwv_snapshot = function () {
      return {
        lcp: { value: null, reason: 'web-vitals-not-loaded' },
        cls: { value: null, reason: 'web-vitals-not-loaded', shifts: shifts },
        inp: {
          value: null,
          reason: 'web-vitals-not-loaded',
          interactions: Array.from(interactionsById.values()),
        },
        fcp: { value: null, reason: 'web-vitals-not-loaded' },
        ttfb: { value: null, reason: 'web-vitals-not-loaded' },
        mainThread: mainThreadSnapshot(),
        cspViolations: cspViolations.slice(),
      };
    };
    return;
  }

  const results = {};
  function capture(name) {
    return function (metric) { results[name] = metric; };
  }

  const opts = { reportAllChanges: true };
  try { webVitals.onLCP(capture('lcp'), opts); } catch { /* noop */ }
  try { webVitals.onCLS(capture('cls'), opts); } catch { /* noop */ }
  try { webVitals.onINP(capture('inp'), opts); } catch { /* noop */ }
  try { webVitals.onFCP(capture('fcp'), opts); } catch { /* noop */ }
  try { webVitals.onTTFB(capture('ttfb'), opts); } catch { /* noop */ }

  // Structured-clone-friendly shallow copy. web-vitals attribution objects contain
  // PerformanceEntry / Node references which can't be cloned; collapse them to plain data.
  function plainAttribution(attr) {
    if (!attr || typeof attr !== 'object') return attr;
    const out = {};
    const keys = Object.keys(attr);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const v = attr[k];
      if (v == null) { out[k] = v; continue; }
      const t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') { out[k] = v; continue; }
      if (typeof v.toJSON === 'function') {
        try { out[k] = v.toJSON(); continue; } catch { /* fallthrough */ }
      }
      if (v.nodeType === 1 && typeof v.tagName === 'string') {
        out[k] = {
          tagName: v.tagName,
          id: v.id || null,
          className: (v.className && v.className.toString) ? v.className.toString() : null,
          selector: nodeToSelector(v),
        };
        continue;
      }
      if (Array.isArray(v)) {
        out[k] = v.map(function (item) {
          if (item && typeof item.toJSON === 'function') {
            try { return item.toJSON(); } catch { return null; }
          }
          return (typeof item === 'object') ? null : item;
        });
        continue;
      }
      if (t === 'object') {
        try { out[k] = JSON.parse(JSON.stringify(v)); } catch { out[k] = null; }
      }
    }
    return out;
  }

  window.__cwv_snapshot = function () {
    const metricNames = ['lcp', 'cls', 'inp', 'fcp', 'ttfb'];
    const snapshot = {};
    for (let i = 0; i < metricNames.length; i += 1) {
      const name = metricNames[i];
      const m = results[name];
      if (m) {
        snapshot[name] = {
          value: m.value,
          rating: m.rating,
          attribution: plainAttribution(m.attribution),
        };
      } else {
        snapshot[name] = { value: null, reason: 'not-observed' };
      }
    }
    // Attach raw event logs to CLS and INP. These are populated whether or not
    // web-vitals observed a "final" metric, so INP in particular may have
    // interactions even when snapshot.inp.value is null (no visibilitychange flush yet).
    snapshot.cls.shifts = shifts.slice();
    snapshot.inp.interactions = Array.from(interactionsById.values());
    snapshot.mainThread = mainThreadSnapshot();
    snapshot.cspViolations = cspViolations.slice();
    return snapshot;
  };
})();
