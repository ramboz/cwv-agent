// Browser-side script injected via page.evaluateOnNewDocument().
// Builds a buffer of all PerformanceResourceTiming entries + tracks LCP time to classify pre/post.
(function () {
  if (typeof window === 'undefined') return;

  const entries = [];
  let lcpTime = null;

  function inferTypeFromExtension(url) {
    try {
      const u = new URL(url, location.href);
      const path = u.pathname.toLowerCase();
      if (/\.(png|jpg|jpeg|webp|gif|avif|svg|ico|bmp)(\?|$)/.test(path)) return 'img';
      if (/\.(woff2?|ttf|otf|eot)(\?|$)/.test(path)) return 'font';
      if (/\.(css)(\?|$)/.test(path)) return 'css';
      if (/\.(mjs|js)(\?|$)/.test(path)) return 'script';
      if (/\.(mp4|webm|ogg|mp3|wav|flac)(\?|$)/.test(path)) return 'media';
    } catch { /* fallthrough */ }
    return null;
  }

  function classify(entry) {
    if (entry.entryType === 'navigation' || entry.initiatorType === 'navigation') return 'navigation';
    const initiator = entry.initiatorType || '';
    if (initiator === 'script') return 'script';
    if (initiator === 'link' || initiator === 'css') {
      // Stylesheets come in with initiatorType 'link' or 'css'.
      const extType = inferTypeFromExtension(entry.name);
      if (extType) return extType;
      return 'css';
    }
    if (initiator === 'img' || initiator === 'image') return 'img';
    if (initiator === 'font') return 'font';
    if (initiator === 'iframe') return 'iframe';
    if (initiator === 'xmlhttprequest' || initiator === 'fetch') {
      const ext = inferTypeFromExtension(entry.name);
      return ext || 'xhr';
    }
    const guess = inferTypeFromExtension(entry.name);
    return guess || (initiator || 'other');
  }

  function roundNumber(n) {
    return (typeof n === 'number' && isFinite(n)) ? Math.round(n) : null;
  }

  function plainServerTiming(entry) {
    const timing = entry && entry.serverTiming;
    if (!timing || typeof timing.length !== 'number' || timing.length === 0) return null;
    const out = [];
    for (let i = 0; i < timing.length; i++) {
      const t = timing[i];
      if (!t) continue;
      out.push({
        name: t.name || null,
        duration: roundNumber(t.duration) || 0,
        description: t.description || null,
      });
    }
    return out.length ? out : null;
  }

  function resourceTtfb(entry) {
    const requestStart = typeof entry.requestStart === 'number' ? entry.requestStart : 0;
    const responseStart = typeof entry.responseStart === 'number' ? entry.responseStart : 0;
    if (requestStart <= 0 || responseStart <= 0 || responseStart < requestStart) return null;
    return roundNumber(responseStart - requestStart);
  }

  function isHttp1Resource(resource) {
    return /^http\/1(?:\.0|\.1)?$/i.test(String((resource && resource.nextHopProtocol) || ''));
  }

  function isCacheMissTiming(timing) {
    if (!timing) return false;
    const name = String(timing.name || '').toLowerCase();
    const description = String(timing.description || '').toLowerCase();
    if (!/(cache|cdn|edge)/.test(name)) return false;
    return /(miss|expired|stale|bypass|revalidat|fwd=uri-miss)/.test(description);
  }

  function hasCdnCacheMiss(resource) {
    const timing = resource && resource.serverTiming;
    if (!Array.isArray(timing)) return false;
    for (let i = 0; i < timing.length; i++) {
      if (isCacheMissTiming(timing[i])) return true;
    }
    return false;
  }

  function toPlain(entry) {
    const type = classify(entry);
    const url = entry.name;
    let domain = '';
    try { domain = new URL(url, location.href).hostname; } catch { /* noop */ }
    return {
      url: url,
      type: type,
      transferSize: entry.transferSize || 0,
      encodedBodySize: entry.encodedBodySize || 0,
      decodedBodySize: entry.decodedBodySize || 0,
      duration: entry.duration || 0,
      renderBlockingStatus: entry.renderBlockingStatus || null,
      priority: entry.fetchPriority || entry.priority || null,
      initiatorType: entry.initiatorType || null,
      startTime: entry.startTime || 0,
      responseEnd: entry.responseEnd || 0,
      ttfb: resourceTtfb(entry),
      domain: domain,
      nextHopProtocol: entry.nextHopProtocol || null,
      serverTiming: plainServerTiming(entry),
    };
  }

  try {
    // Prime with anything already buffered before the observer hooks.
    const buffered = (typeof performance !== 'undefined' && performance.getEntriesByType)
      ? performance.getEntriesByType('resource') : [];
    for (let i = 0; i < buffered.length; i++) entries.push(toPlain(buffered[i]));
    const navigation = (typeof performance !== 'undefined' && performance.getEntriesByType)
      ? performance.getEntriesByType('navigation') : [];
    for (let j = 0; j < navigation.length; j++) entries.push(toPlain(navigation[j]));
  } catch { /* noop */ }

  try {
    const resObs = new PerformanceObserver(function (list) {
      const items = list.getEntries();
      for (let i = 0; i < items.length; i++) entries.push(toPlain(items[i]));
    });
    resObs.observe({ type: 'resource', buffered: true });
  } catch { /* observer unsupported */ }

  try {
    const lcpObs = new PerformanceObserver(function (list) {
      const items = list.getEntries();
      for (let i = 0; i < items.length; i++) {
        const e = items[i];
        // Track the latest LCP candidate time.
        lcpTime = e.startTime || e.renderTime || e.loadTime || lcpTime;
      }
    });
    lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* observer unsupported */ }

  window.__resources_snapshot = function () {
    const all = entries.slice();
    const renderBlocking = [];
    const preLCP = [];
    const postLCP = [];
    const http1 = [];
    const cdnCacheMiss = [];
    const byType = { script: [], css: [], img: [], font: [] };
    const byDomain = {};

    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      if (r.renderBlockingStatus === 'blocking') renderBlocking.push(r);
      if (isHttp1Resource(r)) http1.push(r);
      if (hasCdnCacheMiss(r)) cdnCacheMiss.push(r);
      if (lcpTime != null) {
        if (r.startTime <= lcpTime) preLCP.push(r); else postLCP.push(r);
      }
      if (byType[r.type]) byType[r.type].push(r);
      if (r.domain) {
        if (!byDomain[r.domain]) byDomain[r.domain] = [];
        byDomain[r.domain].push(r);
      }
    }

    return {
      lcpTime: lcpTime,
      total: all.length,
      renderBlocking: renderBlocking,
      preLCP: preLCP,
      postLCP: postLCP,
      http1: http1,
      cdnCacheMiss: cdnCacheMiss,
      byType: byType,
      byDomain: byDomain,
      all: all,
    };
  };
})();
