#!/usr/bin/env node

/**
 * Sanity test for chain-rum-correlator.js.
 *
 * Builds fake RUM + launcher fixtures for each of the four heuristics
 * (C1 INP-chain, C2 LCP-resource, C3 CLS-image, C4 field/lab disagreement),
 * runs correlateChains(), and validates every finding with validateFinding().
 *
 * Exit 0 on success, non-zero otherwise.
 */

import { correlateChains, detectAnimatedReveals, correlateCspViolations } from '../chain-rum-correlator.js';
import { validateFinding } from '../../finding-schema.js';

const PAGE_URL = 'https://www.example.com/pricing';
const DOMAIN = 'www.example.com';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkRumBundle({
  inpP75 = 0,
  lcpP75 = 0,
  clsP75 = 0,
  inpTop = [],
  lcpTop = [],
  clsTop = [],
  urlInp = null,
  urlLcp = null,
  urlCls = null,
} = {}) {
  return {
    domain: DOMAIN,
    daysAnalyzed: 7,
    bundleCount: 500,
    urlFilter: null,
    siteWide: {
      inp: inpP75
        ? { p75: inpP75, sampleSize: inpTop.length * 10 || 100, status: 'poor', topSlow: inpTop }
        : null,
      lcp: lcpP75
        ? { p75: lcpP75, sampleSize: lcpTop.length * 10 || 100, status: 'poor', topSlow: lcpTop }
        : null,
      cls: clsP75
        ? { p75: clsP75, sampleSize: clsTop.length * 10 || 100, status: 'needs-improvement', topSlow: clsTop }
        : null,
      ttfb: null,
    },
    byUrl: [
      {
        url: PAGE_URL,
        bundleCount: 200,
        inp: urlInp != null ? urlInp : inpP75 || null,
        lcp: urlLcp != null ? urlLcp : lcpP75 || null,
        cls: urlCls != null ? urlCls : clsP75 || null,
        ttfb: null,
        score: 3,
      },
    ],
  };
}

function mkLauncherOutput(run) {
  return { url: PAGE_URL, runs: [run] };
}

function mkRun({
  lcpValue = null,
  lcpAttr = {},
  inpValue = null,
  inpAttr = {},
  clsValue = null,
  clsAttr = {},
  resources = { preLCP: [], postLCP: [], renderBlocking: [], byType: { img: [] } },
  fonts = null,
} = {}) {
  const cwv = {};
  if (lcpValue != null) cwv.lcp = { value: lcpValue, rating: 'poor', attribution: lcpAttr };
  if (inpValue != null) cwv.inp = { value: inpValue, rating: 'poor', attribution: inpAttr };
  if (clsValue != null) cwv.cls = { value: clsValue, rating: 'needs-improvement', attribution: clsAttr };
  const run = { cwv, resources };
  if (fonts) run.fonts = fonts;
  return run;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(label, cond, detail) {
  if (cond) {
    process.stdout.write(`  PASS ${label}\n`);
    passed += 1;
  } else {
    process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ''}\n`);
    failed += 1;
    failures.push(label + (detail ? `: ${detail}` : ''));
  }
}

function validateAll(findings, label) {
  let ok = true;
  for (const f of findings) {
    const r = validateFinding(f);
    if (!r.valid) {
      ok = false;
      process.stdout.write(`    INVALID ${f.id}: ${r.errors.join('; ')}\n`);
    }
  }
  assert(`${label} — all findings valid`, ok);
}

// ---------------------------------------------------------------------------
// C1: INP element → deferrable chain
// ---------------------------------------------------------------------------

process.stdout.write('C1: INP element → deferrable chain\n');
{
  const rumBundle = mkRumBundle({
    inpP75: 550,
    inpTop: [{
      value: 620,
      url: PAGE_URL,
      target: 'button.cta',
      interactionType: 'click',
      timestamp: '2026-04-15T12:00:00Z',
    }],
  });
  const gtm = {
    url: 'https://www.googletagmanager.com/gtm.js?id=GTM-XYZ',
    type: 'script', domain: 'www.googletagmanager.com',
    transferSize: 55000, duration: 400, startTime: 800,
    priority: 'Low', initiatorType: 'script', renderBlockingStatus: 'non-blocking',
  };
  const ga = {
    url: 'https://www.google-analytics.com/analytics.js',
    type: 'script', domain: 'www.google-analytics.com',
    transferSize: 48000, duration: 380, startTime: 1400,
    priority: 'Low', initiatorType: 'script', renderBlockingStatus: 'non-blocking',
  };
  const optimizely = {
    url: 'https://cdn.optimizely.com/js/12345.js',
    type: 'script', domain: 'cdn.optimizely.com',
    transferSize: 90000, duration: 600, startTime: 2100,
    priority: 'Low', initiatorType: 'script', renderBlockingStatus: 'non-blocking',
  };
  const run = mkRun({
    inpValue: 480,
    inpAttr: { interactionTarget: 'BUTTON.cta', interactionTime: 2800, inputDelay: 40, processingDuration: 420, presentationDelay: 20 },
    resources: { preLCP: [gtm, ga], postLCP: [optimizely], renderBlocking: [], byType: { img: [] } },
  });
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  assert('C1 emits ≥1 finding', out.findings.length >= 1, `got ${out.findings.length}`);
  const f = out.findings.find((x) => x.id.includes('-c1-'));
  assert('C1 finding id prefix', !!f);
  if (f) {
    assert('C1 source=rum', f.source === 'rum');
    assert('C1 metric=[INP]', Array.isArray(f.metric) && f.metric[0] === 'INP');
    assert('C1 mergedSources contains har (lab match)', Array.isArray(f.mergedSources) && f.mergedSources.includes('har'));
    assert('C1 confidence capped ≤0.90', f.confidence <= 0.90 + 1e-9);
    assert('C1 has rum-bundle evidence', f.evidence.some((e) => e.kind === 'rum-bundle'));
    assert('C1 has resource-timing evidence', f.evidence.some((e) => e.kind === 'resource-timing'));
  }
  validateAll(out.findings, 'C1');
}

process.stdout.write('C1: INP LoAF culprit script attribution\n');
{
  const rumBundle = mkRumBundle({
    inpP75: 550,
    inpTop: [{
      value: 620,
      url: PAGE_URL,
      target: 'button.cta',
      interactionType: 'click',
      timestamp: '2026-04-15T12:00:00Z',
    }],
  });
  const run = mkRun({
    inpValue: 480,
    inpAttr: {
      interactionTarget: 'BUTTON.cta',
      interactionTime: 2800,
      inputDelay: 40,
      processingDuration: 420,
      presentationDelay: 20,
    },
  });
  run.cwv.inp.interactions = [
    {
      interactionId: 99,
      name: 'click',
      target: 'button.cta',
      duration: 480,
      startTime: 2800,
      processingStart: 2840,
      processingEnd: 3260,
      entryCount: 1,
    },
  ];
  run.cwv.mainThread = {
    loaf: [{
      startTime: 2790,
      duration: 560,
      renderStart: 2820,
      styleAndLayoutStart: 3190,
      blockingDuration: 390,
      scripts: [
        {
          sourceURL: 'https://www.example.com/scripts/checkout.js',
          sourceFunctionName: 'renderPaymentOptions',
          invoker: 'EventListener.handleEvent',
          invokerType: 'event-listener',
          duration: 310,
          forcedStyleAndLayoutDuration: 42,
          pauseDuration: 0,
        },
        {
          sourceURL: 'https://www.example.com/scripts/analytics.js',
          sourceFunctionName: 'trackClick',
          invoker: 'EventListener.handleEvent',
          invokerType: 'event-listener',
          duration: 54,
          forcedStyleAndLayoutDuration: 0,
          pauseDuration: 0,
        },
      ],
    }],
    longTasks: [],
  };
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const c1 = out.findings.find((f) => f.id.includes('-c1-'));
  assert('C1 emits LoAF-backed finding', !!c1);
  if (c1) {
    assert('C1 LoAF source=perf_observer', c1.source === 'perf_observer', `got ${c1.source}`);
    assert('C1 LoAF confidence capped <= 0.85', c1.confidence <= 0.85 + 1e-9, `got ${c1.confidence}`);
    assert('C1 LoAF mergedSources includes rum', c1.mergedSources.includes('rum'));
    assert('C1 LoAF mergedSources includes perf_observer', c1.mergedSources.includes('perf_observer'));
    const loafEvidence = c1.evidence.find((e) => e.kind === 'long-animation-frame');
    assert('C1 has long-animation-frame evidence', !!loafEvidence);
    if (loafEvidence) {
      assert('C1 LoAF evidence names top blocking script',
        loafEvidence.data.topScripts[0].sourceURL === 'https://www.example.com/scripts/checkout.js');
      assert('C1 LoAF evidence ranks by blockingDuration',
        loafEvidence.data.topScripts[0].blockingDuration >= loafEvidence.data.topScripts[1].blockingDuration);
    }
    assert('C1 LoAF cause mentions blocking script', c1.cause.includes('checkout.js'));
  }
  validateAll(out.findings, 'C1 LoAF');
}

// ---------------------------------------------------------------------------
// C2: LCP element → late/low-priority resource
// ---------------------------------------------------------------------------

process.stdout.write('C2: LCP element → late/low-priority resource\n');
{
  const heroUrl = 'https://www.example.com/hero.jpg';
  const rumBundle = mkRumBundle({
    lcpP75: 3800,
    lcpTop: [{ value: 4100, url: PAGE_URL, target: 'img.hero', timestamp: '2026-04-15T12:00:00Z' }],
  });
  const hero = {
    url: heroUrl, type: 'img', domain: DOMAIN,
    transferSize: 320000, duration: 900, startTime: 2400,
    priority: 'Low', initiatorType: 'img', renderBlockingStatus: 'non-blocking',
  };
  const run = mkRun({
    lcpValue: 3500,
    lcpAttr: { target: 'IMG.hero', url: heroUrl, resourceLoadDelay: 1800, elementRenderDelay: 200, timeToFirstByte: 300 },
    resources: { preLCP: [hero], postLCP: [], renderBlocking: [], byType: { img: [hero] } },
  });
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const f = out.findings.find((x) => x.id.includes('-c2-'));
  assert('C2 emits finding', !!f);
  if (f) {
    assert('C2 source=rum', f.source === 'rum');
    assert('C2 metric=[LCP]', f.metric[0] === 'LCP');
    assert('C2 has patches.preloads', !!(f.patches && Array.isArray(f.patches.preloads) && f.patches.preloads.length));
    assert('C2 patches.markup sets fetchpriority', !!(f.patches && Array.isArray(f.patches.markup) && f.patches.markup[0].attrs && f.patches.markup[0].attrs.fetchpriority === 'high'));
    assert('C2 mergedSources has rum+har', f.mergedSources.includes('rum') && f.mergedSources.includes('har'));
    assert('C2 evidence has rum-bundle', f.evidence.some((e) => e.kind === 'rum-bundle'));
    assert('C2 evidence has cwv-attribution', f.evidence.some((e) => e.kind === 'cwv-attribution'));
    assert('C2 evidence has resource-timing', f.evidence.some((e) => e.kind === 'resource-timing'));
  }
  validateAll(out.findings, 'C2');

  // Example finding for log output.
  if (f) {
    process.stdout.write('  sample C2 finding:\n');
    process.stdout.write(JSON.stringify(f, null, 2).split('\n').map((l) => '    ' + l).join('\n') + '\n');
  }
}

// ---------------------------------------------------------------------------
// C7: font-face descriptors → text-LCP / font-CLS attribution
// ---------------------------------------------------------------------------

process.stdout.write('C7: font swap on text LCP element\n');
{
  const run = mkRun({
    lcpValue: 3400,
    lcpAttr: { element: 'H1.hero', elementRenderDelay: 450 },
    fonts: {
      count: 1,
      loaded: 1,
      swapRisk: 1,
      usedFonts: {
        h1: 'Brand Sans, Arial, sans-serif',
        body: 'Brand Sans, Arial, sans-serif',
      },
      faces: [{
        family: 'Brand Sans',
        style: 'normal',
        weight: '700',
        stretch: 'normal',
        display: 'swap',
        unicodeRange: 'U+000-5FF',
        featureSettings: 'normal',
        ascentOverride: null,
        descentOverride: null,
        lineGapOverride: null,
        sizeAdjust: null,
        status: 'loaded',
      }],
    },
  });
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const c7 = out.findings.find((f) => f.id.includes('-font-c7-') && f.metric.includes('LCP'));
  assert('C7 emits text-LCP font finding', !!c7);
  if (c7) {
    assert('C7 LCP source=perf_observer', c7.source === 'perf_observer');
    assert('C7 LCP confidence capped <= 0.85', c7.confidence <= 0.85 + 1e-9);
    assert('C7 LCP evidence includes font-face', c7.evidence.some((e) => e.kind === 'font-face'));
    assert('C7 LCP recommendation mentions size-adjust', c7.recommendation.includes('size-adjust'));
    assert('C7 LCP cause names font family', c7.cause.includes('Brand Sans'));
  }
  validateAll(out.findings, 'C7 text LCP');
}

process.stdout.write('C7: font swap correlates with CLS text source\n');
{
  const run = mkRun({
    clsValue: 0.09,
    clsAttr: { largestShiftTarget: 'H1.hero', loadState: 'after-load' },
    fonts: {
      count: 1,
      loaded: 1,
      swapRisk: 1,
      usedFonts: {
        h1: 'Brand Sans, Arial, sans-serif',
        body: 'Brand Sans, Arial, sans-serif',
      },
      faces: [{
        family: 'Brand Sans',
        style: 'normal',
        weight: '700',
        stretch: 'normal',
        display: 'auto',
        unicodeRange: 'U+000-5FF',
        featureSettings: 'normal',
        ascentOverride: null,
        descentOverride: null,
        lineGapOverride: null,
        sizeAdjust: null,
        status: 'loaded',
      }],
    },
  });
  run.cwv.cls.shifts = [{
    value: 0.07,
    startTime: 1800,
    hadRecentInput: false,
    sources: [{
      target: 'h1.hero',
      previousRect: { x: 0, y: 20, width: 600, height: 48 },
      currentRect: { x: 0, y: 20, width: 620, height: 54 },
    }],
  }];
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const c7 = out.findings.find((f) => f.id.includes('-font-c7-') && f.metric.includes('CLS'));
  assert('C7 emits font-CLS finding', !!c7);
  if (c7) {
    assert('C7 CLS source=perf_observer', c7.source === 'perf_observer');
    assert('C7 CLS confidence capped <= 0.85', c7.confidence <= 0.85 + 1e-9);
    assert('C7 CLS evidence target is shift source',
      c7.evidence.some((e) => e.kind === 'cwv-attribution' && e.data && e.data.target === 'h1.hero'));
    assert('C7 CLS recommendation mentions ascent-override', c7.recommendation.includes('ascent-override'));
  }
  validateAll(out.findings, 'C7 font CLS');
}

process.stdout.write('C7: system-font-only page does not emit font finding\n');
{
  const run = mkRun({
    lcpValue: 3300,
    lcpAttr: { element: 'H1.hero', elementRenderDelay: 450 },
    fonts: {
      count: 0,
      loaded: 0,
      swapRisk: 0,
      faces: [],
      usedFonts: {
        h1: 'system-ui, sans-serif',
        body: 'system-ui, sans-serif',
      },
    },
  });
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  assert('C7 emits no finding for system-font-only page',
    !out.findings.some((f) => f.id.includes('-font-c7-')));
}

// ---------------------------------------------------------------------------
// C8: transport/cache resource timing signal
// ---------------------------------------------------------------------------

process.stdout.write('C8: HTTP/1.x render-blocking/pre-LCP resources\n');
{
  const css = {
    url: 'https://www.example.com/styles/blocking.css',
    type: 'css',
    domain: DOMAIN,
    transferSize: 24000,
    duration: 280,
    startTime: 120,
    ttfb: 140,
    priority: 'High',
    initiatorType: 'link',
    renderBlockingStatus: 'blocking',
    nextHopProtocol: 'http/1.1',
    serverTiming: null,
  };
  const run = mkRun({
    resources: {
      lcpTime: 1500,
      all: [css],
      preLCP: [css],
      renderBlocking: [css],
      http1: [css],
      cdnCacheMiss: [],
      byType: { css: [css], img: [] },
    },
  });
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const c8 = out.findings.find((f) => f.id.includes('-connection-c8-'));
  assert('C8 emits HTTP/1.x critical finding', !!c8);
  if (c8) {
    assert('C8 HTTP/1 source=har', c8.source === 'har');
    assert('C8 HTTP/1 confidence <= 0.85', c8.confidence <= 0.85 + 1e-9);
    assert('C8 HTTP/1 evidence includes protocol',
      c8.evidence[0].data.nextHopProtocol === 'http/1.1',
      JSON.stringify(c8.evidence[0].data));
    assert('C8 HTTP/1 cause cites offending URL', c8.cause.includes(css.url));
  }
  validateAll(out.findings, 'C8 HTTP/1');
}

process.stdout.write('C8: CDN cache miss on critical path with high TTFB\n');
{
  const doc = {
    url: PAGE_URL,
    type: 'document',
    domain: DOMAIN,
    transferSize: 78000,
    duration: 1220,
    startTime: 0,
    ttfb: 940,
    priority: 'High',
    initiatorType: 'navigation',
    renderBlockingStatus: null,
    nextHopProtocol: 'h2',
    serverTiming: [{ name: 'cdn-cache', duration: 0, description: 'MISS from edge' }],
  };
  const run = mkRun({
    resources: {
      lcpTime: 2200,
      all: [doc],
      preLCP: [doc],
      renderBlocking: [],
      http1: [],
      cdnCacheMiss: [doc],
      byType: {},
    },
  });
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const cache = out.findings.find((f) => f.id.includes('-cache-c8-'));
  assert('C8 emits CDN-miss high-TTFB finding', !!cache);
  if (cache) {
    assert('C8 CDN miss source=har', cache.source === 'har');
    assert('C8 CDN miss metric includes TTFB', cache.metric.includes('TTFB'));
    assert('C8 CDN miss confidence <= 0.85', cache.confidence <= 0.85 + 1e-9);
    assert('C8 CDN miss evidence preserves serverTiming',
      cache.evidence[0].data.serverTiming[0].description === 'MISS from edge');
    assert('C8 CDN miss evidence preserves ttfb', cache.evidence[0].data.ttfb === 940);
  }
  assert('C8 CDN miss is not duplicated as generic slow TTFB',
    !out.findings.some((f) => f.id.includes('-ttfb-c8-')),
    `got ${out.findings.map((f) => f.id).join(', ')}`);
  validateAll(out.findings, 'C8 CDN miss');
}

process.stdout.write('C8: slow per-resource TTFB threshold\n');
{
  const api = {
    url: 'https://api.example.com/products.json',
    type: 'xhr',
    domain: 'api.example.com',
    transferSize: 18000,
    duration: 1320,
    startTime: 2400,
    ttfb: 1180,
    priority: 'Low',
    initiatorType: 'fetch',
    renderBlockingStatus: 'non-blocking',
    nextHopProtocol: 'h2',
    serverTiming: null,
  };
  const run = mkRun({
    resources: {
      lcpTime: 1500,
      all: [api],
      preLCP: [],
      postLCP: [api],
      renderBlocking: [],
      http1: [],
      cdnCacheMiss: [],
      byType: { xhr: [api] },
    },
  });
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const slow = out.findings.find((f) => f.id.includes('-ttfb-c8-'));
  assert('C8 emits slow resource TTFB finding', !!slow);
  if (slow) {
    assert('C8 slow TTFB source=har', slow.source === 'har');
    assert('C8 slow TTFB uses documented 800ms threshold in recommendation',
      slow.recommendation.includes('800ms'));
    assert('C8 slow TTFB evidence cites offending URL', slow.evidence[0].data.url === api.url);
  }
  assert('C8 slow TTFB does not imply CDN miss',
    !out.findings.some((f) => f.id.includes('-cache-c8-')));
  validateAll(out.findings, 'C8 slow TTFB');
}

process.stdout.write('C8: cross-origin null serverTiming does not false cache-miss\n');
{
  const thirdParty = {
    url: 'https://static.third-party.example/widget.js',
    type: 'script',
    domain: 'static.third-party.example',
    transferSize: 45000,
    duration: 360,
    startTime: 900,
    ttfb: 220,
    priority: 'Low',
    initiatorType: 'script',
    renderBlockingStatus: 'non-blocking',
    nextHopProtocol: 'h2',
    serverTiming: null,
  };
  const run = mkRun({
    resources: {
      lcpTime: 1500,
      all: [thirdParty],
      preLCP: [thirdParty],
      renderBlocking: [],
      http1: [],
      cdnCacheMiss: [],
      byType: { script: [thirdParty] },
    },
  });
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  assert('C8 emits no CDN-miss finding when serverTiming is null',
    !out.findings.some((f) => f.id.includes('-cache-c8-')),
    `got ${out.findings.map((f) => f.id).join(', ')}`);
  assert('C8 emits no transport/cache finding for benign null serverTiming fixture',
    !out.findings.some((f) => f.id.includes('-c8-')),
    `got ${out.findings.map((f) => f.id).join(', ')}`);
}

// ---------------------------------------------------------------------------
// C9: CSP violations as failed-patch evidence, not standalone findings
// ---------------------------------------------------------------------------

process.stdout.write('C9: CSP blocked patched preload is attached as diagnosis evidence\n');
{
  const heroUrl = 'https://www.example.com/blocked-hero.webp';
  const rumBundle = mkRumBundle({
    lcpP75: 3800,
    lcpTop: [{ value: 4100, url: PAGE_URL, target: 'img.hero', timestamp: '2026-04-15T12:00:00Z' }],
  });
  const hero = {
    url: heroUrl, type: 'img', domain: DOMAIN,
    transferSize: 320000, duration: 900, startTime: 2400,
    priority: 'Low', initiatorType: 'img', renderBlockingStatus: 'non-blocking',
  };
  const run = mkRun({
    lcpValue: 3500,
    lcpAttr: { target: 'IMG.hero', url: heroUrl, resourceLoadDelay: 1800, elementRenderDelay: 200, timeToFirstByte: 300 },
    resources: { preLCP: [hero], postLCP: [], renderBlocking: [], byType: { img: [hero] } },
  });
  run.cwv.cspViolations = [{
    violatedDirective: 'img-src',
    effectiveDirective: 'img-src',
    blockedURI: heroUrl,
    sourceFile: PAGE_URL,
    lineNumber: 1,
    columnNumber: 1,
    disposition: 'enforce',
  }];
  const launcherOutput = mkLauncherOutput(run);
  launcherOutput.appliedPatches = {
    applied: true,
    preloads: [{ href: heroUrl, as: 'image', fetchpriority: 'high' }],
  };

  const out = correlateChains({ rumBundle, launcherOutput });
  const c2 = out.findings.find((f) => f.id.includes('-c2-'));
  assert('C9 keeps the underlying C2 finding, not a standalone C9 finding', !!c2 && !out.findings.some((f) => f.id.includes('-c9-')));
  assert('C9 diagnostics record one blocked patch',
    out.diagnostics && out.diagnostics.csp.blockedPatches.length === 1,
    out.diagnostics && JSON.stringify(out.diagnostics.csp));
  assert('C9 summary exposes blocked patch count', /cspBlockedPatches=1/.test(out.summary), out.summary);
  if (c2) {
    const cspEvidence = c2.evidence.find((e) => e.kind === 'csp-violation');
    assert('C9 attaches csp-violation evidence to matching patch finding', !!cspEvidence);
    assert('C9 evidence preserves blockedURI', cspEvidence && cspEvidence.data.blockedURI === heroUrl);
    assert('C9 evidence names matched patch source', cspEvidence && cspEvidence.data.matchedPatch.source === 'preloads');
  }
  validateAll(out.findings, 'C9 blocked preload');
}

process.stdout.write('C9: unpatched baseline CSP is context only\n');
{
  const run = mkRun({});
  run.cwv.cspViolations = [{
    violatedDirective: 'script-src',
    effectiveDirective: 'script-src',
    blockedURI: 'https://tag.example.com/pixel.js',
    sourceFile: PAGE_URL,
    lineNumber: 4,
    columnNumber: 2,
    disposition: 'enforce',
  }];
  const diagnostics = correlateCspViolations(run, {}, { url: PAGE_URL });
  assert('C9 baseline records violation', diagnostics.violations.length === 1);
  assert('C9 baseline has no blocked patch matches', diagnostics.blockedPatches.length === 0);

  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  assert('C9 baseline does not create a CWV finding', out.findings.length === 0, `got ${out.findings.map((f) => f.id).join(', ')}`);
  assert('C9 baseline diagnostics still expose violation context',
    out.diagnostics.csp.violations.length === 1 && out.diagnostics.csp.blockedPatches.length === 0);
}

process.stdout.write('C9: rewriteBody-injected third-party URL can be matched when CSP blocks it\n');
{
  const injectedUrl = 'https://tag.example.com/injected.js';
  const run = mkRun({});
  run.cwv.cspViolations = [{
    violatedDirective: 'script-src-elem',
    effectiveDirective: 'script-src-elem',
    blockedURI: injectedUrl,
    sourceFile: PAGE_URL,
    lineNumber: 8,
    columnNumber: 2,
    disposition: 'enforce',
  }];

  const fromSummary = correlateCspViolations(run, {
    rewriteBody: [{
      urlPattern: '*theme.js*',
      injectedUrls: [injectedUrl],
    }],
  }, { url: PAGE_URL });
  assert('C9 matches launcher-summary rewriteBody injectedUrls',
    fromSummary.blockedPatches.length === 1,
    JSON.stringify(fromSummary));
  assert('C9 summary match records rewrite injected source',
    fromSummary.blockedPatches[0].patch.source === 'rewriteBody.injectedUrls',
    JSON.stringify(fromSummary.blockedPatches[0].patch));

  const fromRawPatch = correlateCspViolations(run, {
    rewriteBody: [{
      urlPattern: '*theme.js*',
      replacements: [{ find: '</body>', replace: `<script src="${injectedUrl}"></script></body>` }],
    }],
  }, { url: PAGE_URL });
  assert('C9 matches raw rewriteBody replacement URL hints',
    fromRawPatch.blockedPatches.length === 1,
    JSON.stringify(fromRawPatch));
  assert('C9 raw match records replacement source',
    fromRawPatch.blockedPatches[0].patch.source === 'rewriteBody.replacements',
    JSON.stringify(fromRawPatch.blockedPatches[0].patch));
}

process.stdout.write('C9: rewriteBody-injected relative URL can be matched when CSP blocks it\n');
{
  const injectedPath = '/scripts/injected.js';
  const blockedURI = new URL(injectedPath, PAGE_URL).href;
  const run = mkRun({});
  run.cwv.cspViolations = [{
    violatedDirective: 'script-src-elem',
    effectiveDirective: 'script-src-elem',
    blockedURI,
    sourceFile: PAGE_URL,
    lineNumber: 11,
    columnNumber: 4,
    disposition: 'enforce',
  }];

  const fromSummary = correlateCspViolations(run, {
    rewriteBody: [{
      urlPattern: '*theme.js*',
      injectedUrls: [injectedPath],
    }],
  }, { url: PAGE_URL });
  assert('C9 matches launcher-summary rewriteBody relative injectedUrls',
    fromSummary.blockedPatches.length === 1,
    JSON.stringify(fromSummary));

  const fromRawPatch = correlateCspViolations(run, {
    rewriteBody: [{
      urlPattern: '*theme.js*',
      replacements: [{ find: '</body>', replace: `<script src="${injectedPath}"></script></body>` }],
    }],
  }, { url: PAGE_URL });
  assert('C9 matches raw rewriteBody relative replacement URL hints',
    fromRawPatch.blockedPatches.length === 1,
    JSON.stringify(fromRawPatch));
  assert('C9 raw relative match records replacement source',
    fromRawPatch.blockedPatches[0].patch.source === 'rewriteBody.replacements',
    JSON.stringify(fromRawPatch.blockedPatches[0].patch));
}

// ---------------------------------------------------------------------------
// C3: CLS element → missing-dimensions image
// ---------------------------------------------------------------------------

process.stdout.write('C3: CLS element → missing-dimensions image\n');
{
  const imgUrl = 'https://www.example.com/promo.jpg';
  const rumBundle = mkRumBundle({
    clsP75: 0.18,
    clsTop: [{ value: 0.12, url: PAGE_URL, target: 'img.promo', timestamp: '2026-04-15T12:00:00Z' }],
  });
  const img = {
    url: imgUrl, type: 'img', domain: DOMAIN,
    transferSize: 80000, duration: 500, startTime: 1500,
    priority: 'Low', initiatorType: 'img', renderBlockingStatus: 'non-blocking',
  };
  const run = mkRun({
    clsValue: 0.15,
    clsAttr: { largestShiftTarget: 'IMG.promo', largestShiftValue: 0.12, loadState: 'complete' },
    resources: { preLCP: [img], postLCP: [], renderBlocking: [], byType: { img: [img] } },
  });
  const htmlFindings = [{
    evidence: [{
      kind: 'rule-violation',
      data: { ruleId: 'img-missing-dimensions', match: { url: imgUrl }, context: 'no width/height' },
    }],
  }];
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run), htmlFindings });
  const f = out.findings.find((x) => x.id.includes('-c3-'));
  assert('C3 emits finding', !!f);
  if (f) {
    assert('C3 source=rum', f.source === 'rum');
    assert('C3 metric=[CLS]', f.metric[0] === 'CLS');
    assert('C3 impactReduction.score set', typeof f.impactReduction.score === 'number');
    assert('C3 mergedSources includes html', f.mergedSources.includes('html'));
    assert('C3 rootCause=true (culprit found)', f.rootCause === true);
  }
  validateAll(out.findings, 'C3');
}

process.stdout.write('C3: aggregates repeated RUM CLS samples for the same lab target\n');
{
  const rumBundle = mkRumBundle({
    clsP75: 0.8,
    clsTop: [
      { value: 1.15, url: PAGE_URL, timestamp: '2026-04-15T12:00:00Z' },
      { value: 1.05, url: PAGE_URL, timestamp: '2026-04-15T12:01:00Z' },
      { value: 0.92, url: PAGE_URL, timestamp: '2026-04-15T12:02:00Z' },
    ],
  });
  const run = mkRun({
    clsValue: 0.9,
    clsAttr: { largestShiftTarget: '#select-your-insurance', largestShiftValue: 0.55, loadState: 'dom-content-loaded' },
    resources: { preLCP: [], postLCP: [], renderBlocking: [], byType: { img: [] } },
  });
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const c3 = out.findings.filter((x) => x.id.includes('-c3-'));
  assert('C3 emits one aggregated finding, not one per topSlow row', c3.length === 1, `got ${c3.length}`);
  if (c3.length) {
    const rumEvidence = c3[0].evidence.find((e) => e.kind === 'rum-bundle');
    assert('C3 aggregation preserves count', rumEvidence.data.sampleAggregation.count === 3);
    assert('C3 aggregation preserves values', rumEvidence.data.sampleAggregation.values.length === 3);
    assert('C3 value distribution preserves sample count', rumEvidence.data.valueDistribution.sampleCount === 3);
  }
  validateAll(c3, 'C3 aggregation');
}

process.stdout.write('C3: dedupe repeated RUM samples by selector + URL + metric\n');
{
  const rumBundle = mkRumBundle({
    clsP75: 1.0,
    clsTop: [
      { value: 1.153, url: PAGE_URL, target: '#select-your-insurance', timestamp: '2026-06-17T12:00:00Z' },
      { value: 1.152, url: PAGE_URL, target: '#select-your-insurance', timestamp: '2026-06-17T12:05:00Z' },
      { value: 0.939, url: PAGE_URL, target: '#select-your-insurance', timestamp: '2026-06-17T12:10:00Z' },
    ],
  });
  const run = mkRun({
    clsValue: 1.1,
    clsAttr: { largestShiftTarget: '#select-your-insurance', largestShiftValue: 1.153, loadState: 'complete' },
  });
  run.cwv.cls.shifts = [
    { value: 1.153, startTime: 1800, hadRecentInput: false,
      sources: [{ target: '#select-your-insurance', previousRect: { width: 1200, height: 0 }, currentRect: { width: 1200, height: 392 } }] },
  ];
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const c3 = out.findings.filter((f) => f.id.includes('-c3-'));
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));
  assert('C3 emits one aggregate finding for repeated RUM samples', c3.length === 1, `got ${c3.length}`);
  assert('C6 suppressed for same selector already covered by C3', c6.length === 0, `got ${c6.length}`);
  if (c3.length) {
    const rumEvidence = c3[0].evidence.find((e) => e.kind === 'rum-bundle');
    const distribution = rumEvidence && rumEvidence.data && rumEvidence.data.valueDistribution;
    assert('C3 evidence preserves value distribution',
      distribution && distribution.sampleCount === 3,
      rumEvidence && JSON.stringify(rumEvidence.data));
    assert('C3 evidence preserves max value',
      distribution && distribution.max === 1.153,
      distribution && JSON.stringify(distribution));
  }
  validateAll(out.findings, 'C3 aggregate');
}

// ---------------------------------------------------------------------------
// C4: Field/lab disagreement (lab much better than field)
// ---------------------------------------------------------------------------

process.stdout.write('C4: field/lab disagreement\n');
{
  // Lab LCP=1500ms, RUM p75=4000ms -> ratio 0.375 < 0.5 -> flag.
  const rumBundle = mkRumBundle({
    lcpP75: 4000,
    lcpTop: [{ value: 4200, url: PAGE_URL, target: 'img.hero', timestamp: '2026-04-15T12:00:00Z' }],
  });
  const run = mkRun({
    lcpValue: 1500,
    lcpAttr: { target: 'IMG.hero', url: 'https://www.example.com/hero.jpg' },
    resources: { preLCP: [], postLCP: [], renderBlocking: [], byType: { img: [] } },
  });
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const f = out.findings.find((x) => x.id.includes('-c4-'));
  assert('C4 emits disagreement finding', !!f);
  if (f) {
    assert('C4 status=draft (meta)', f.status === 'draft');
    assert('C4 type=opportunity', f.type === 'opportunity');
    assert('C4 severity=low', f.severity === 'low');
    assert('C4 has rum-bundle evidence', f.evidence.some((e) => e.kind === 'rum-bundle'));
    assert('C4 has cwv-attribution evidence', f.evidence.some((e) => e.kind === 'cwv-attribution'));
  }
  validateAll(out.findings, 'C4');
}

// ---------------------------------------------------------------------------
// C5: Lab INP interactions (event log)
// ---------------------------------------------------------------------------

process.stdout.write('C5: lab INP interactions from event log\n');
{
  const run = mkRun({
    inpValue: 280,
    inpAttr: { interactionTarget: 'BUTTON.cta' },
  });
  run.cwv.inp.interactions = [
    // slow click — should emit
    {
      interactionId: 101, name: 'click', target: 'button.submit',
      duration: 320, startTime: 5000, processingStart: 5020, processingEnd: 5280, entryCount: 2,
    },
    // medium pointerdown — should emit
    {
      interactionId: 102, name: 'pointerdown', target: 'a.nav-link',
      duration: 95, startTime: 6200, processingStart: 6210, processingEnd: 6290, entryCount: 1,
    },
    // below threshold — should NOT emit
    {
      interactionId: 103, name: 'click', target: 'a.footer-link',
      duration: 35, startTime: 7000, processingStart: 7005, processingEnd: 7030, entryCount: 1,
    },
  ];
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const c5 = out.findings.filter((f) => f.id.includes('-c5-'));
  assert('C5 emits 2 findings (above threshold only)', c5.length === 2, `got ${c5.length}`);
  assert('C5 ranked by duration desc', c5[0].impactReduction.valueMs >= c5[1].impactReduction.valueMs);
  assert('C5 top finding targets button.submit', c5[0].evidence[0].data.target === 'button.submit');
  assert('C5 source=perf_observer', c5.every((f) => f.source === 'perf_observer'));
  assert('C5 confidence <= 0.85', c5.every((f) => f.confidence <= 0.85));
  validateAll(c5, 'C5');
}

// Dedupe check: C1 should suppress a C5 that shares the same target.
process.stdout.write('C5: dedupe against C1\n');
{
  const rumBundle = mkRumBundle({
    inpP75: 550,
    inpTop: [{ value: 600, url: PAGE_URL, target: 'button.submit', interactionType: 'click', timestamp: '2026-04-15T12:00:00Z' }],
  });
  const gtm = {
    url: 'https://www.googletagmanager.com/gtm.js', type: 'script',
    domain: 'www.googletagmanager.com', transferSize: 55000, duration: 400, startTime: 800,
    priority: 'Low', initiatorType: 'script', renderBlockingStatus: 'non-blocking',
  };
  const run = mkRun({
    inpValue: 480,
    inpAttr: { interactionTarget: 'BUTTON.submit' },
    resources: { preLCP: [gtm], postLCP: [], renderBlocking: [], byType: { img: [] } },
  });
  run.cwv.inp.interactions = [
    { interactionId: 1, name: 'click', target: 'button.submit', duration: 300,
      startTime: 1000, processingStart: 1020, processingEnd: 1280, entryCount: 1 },
  ];
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const c1 = out.findings.filter((f) => f.id.includes('-c1-'));
  const c5 = out.findings.filter((f) => f.id.includes('-c5-'));
  assert('C1 fires for button.submit', c1.length === 1);
  assert('C5 suppressed (same target as C1)', c5.length === 0, `got ${c5.length}`);
}

// ---------------------------------------------------------------------------
// C6: Lab CLS shifts (event log)
// ---------------------------------------------------------------------------

process.stdout.write('C6: lab CLS shifts from event log\n');
{
  const run = mkRun({
    clsValue: 0.45,
    clsAttr: { largestShiftTarget: 'div.hero', loadState: 'complete' },
  });
  run.cwv.cls.shifts = [
    // largest — dedupes against C3/attr via largestShiftTarget
    {
      value: 0.30, startTime: 2000, hadRecentInput: false,
      sources: [{ target: 'div.hero', previousRect: { x: 0, y: 0, width: 300, height: 0 }, currentRect: { x: 0, y: 0, width: 300, height: 400 } }],
    },
    // second — should emit
    {
      value: 0.08, startTime: 3000, hadRecentInput: false,
      sources: [{ target: 'aside.sidebar', previousRect: { width: 200, height: 0 }, currentRect: { width: 200, height: 600 } }],
    },
    // third — should emit
    {
      value: 0.05, startTime: 4000, hadRecentInput: false,
      sources: [{ target: 'footer.site-footer', previousRect: null, currentRect: { width: 1200, height: 200 } }],
    },
    // below threshold — should NOT emit
    {
      value: 0.01, startTime: 5000, hadRecentInput: false,
      sources: [{ target: 'p.tagline', previousRect: null, currentRect: { width: 400, height: 20 } }],
    },
    // hadRecentInput — should NOT emit
    {
      value: 0.20, startTime: 6000, hadRecentInput: true,
      sources: [{ target: 'div.after-click', previousRect: null, currentRect: { width: 300, height: 300 } }],
    },
  ];
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));
  // Without RUM/C3 dedupe, all 3 above-threshold !hadRecentInput shifts emit (including div.hero).
  assert('C6 emits 3 findings (above threshold, !hadRecentInput)', c6.length === 3, `got ${c6.length}`);
  assert('C6 ranked by shift score desc', c6[0].impactReduction.score >= c6[1].impactReduction.score
    && c6[1].impactReduction.score >= c6[2].impactReduction.score);
  assert('C6 top shift targets div.hero', c6[0].evidence[0].data.target === 'div.hero');
  assert('C6 source=perf_observer', c6.every((f) => f.source === 'perf_observer'));
  assert('C6 confidence <= 0.85', c6.every((f) => f.confidence <= 0.85));
  assert('C6 no finding for p.tagline', !c6.some((f) => f.evidence[0].data.target === 'p.tagline'));
  assert('C6 no finding for hadRecentInput shift', !c6.some((f) => f.evidence[0].data.target === 'div.after-click'));
  validateAll(c6, 'C6');
}

// Dedupe check: C3 should suppress a C6 on the same target.
process.stdout.write('C6: dedupe against C3\n');
{
  const rumBundle = mkRumBundle({
    clsP75: 0.25,
    clsTop: [{ value: 0.35, url: PAGE_URL, target: 'div.hero', timestamp: '2026-04-15T12:00:00Z' }],
  });
  const run = mkRun({
    clsValue: 0.30,
    clsAttr: { largestShiftTarget: 'div.hero', loadState: 'complete' },
  });
  run.cwv.cls.shifts = [
    { value: 0.30, startTime: 2000, hadRecentInput: false,
      sources: [{ target: 'div.hero', previousRect: null, currentRect: { width: 300, height: 400 } }] },
  ];
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const c3 = out.findings.filter((f) => f.id.includes('-c3-'));
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));
  assert('C3 fires for div.hero', c3.length >= 1);
  assert('C6 suppressed (same target as C3)', c6.length === 0, `got ${c6.length}`);
}

// Regression: the pets-site case had C3 cite "#main" (RUM byElement shape — just id)
// while C6 cited "main#main" (lab PerformanceObserver layout-shift source —
// tag + id). Before the fix, the strict Set equality on normalized leaf
// tokens didn't collapse these, producing a duplicate finding for the same
// element. Both shapes must now be treated as semantically equivalent.
process.stdout.write('C6: tag#id dedupes against #id (the pets-site case regression)\n');
{
  const rumBundle = mkRumBundle({
    clsP75: 0.15,
    clsTop: [{ value: 0.11, url: PAGE_URL, target: '#main', timestamp: '2026-04-15T12:00:00Z' }],
  });
  const run = mkRun({
    clsValue: 0.10,
    clsAttr: { largestShiftTarget: 'main#main', loadState: 'complete' },
  });
  run.cwv.cls.shifts = [
    { value: 0.10, startTime: 7319, hadRecentInput: false,
      sources: [{ target: 'main#main', previousRect: null, currentRect: { width: 1280, height: 800 } }] },
  ];
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const c3 = out.findings.filter((f) => f.id.includes('-c3-'));
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));
  assert('C3 fires for #main', c3.length >= 1);
  assert('C6 suppressed — main#main ≡ #main', c6.length === 0, `got ${c6.length}`);
}

// And the reverse direction: RUM leaf is "main#main" (shouldn't happen given
// current rum-fetch shape, but defensive) while lab shift source is "#main".
process.stdout.write('C6: #id dedupes against tag#id (reverse)\n');
{
  const rumBundle = mkRumBundle({
    clsP75: 0.15,
    clsTop: [{ value: 0.11, url: PAGE_URL, target: 'main#main', timestamp: '2026-04-15T12:00:00Z' }],
  });
  const run = mkRun({
    clsValue: 0.10,
    clsAttr: { largestShiftTarget: '#main', loadState: 'complete' },
  });
  run.cwv.cls.shifts = [
    { value: 0.10, startTime: 7319, hadRecentInput: false,
      sources: [{ target: '#main', previousRect: null, currentRect: { width: 1280, height: 800 } }] },
  ];
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const c3 = out.findings.filter((f) => f.id.includes('-c3-'));
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));
  assert('C3 fires for main#main', c3.length >= 1);
  assert('C6 suppressed — #main ≡ main#main (reverse)', c6.length === 0, `got ${c6.length}`);
}

// Negative case: distinct ids must NOT dedupe against each other.
// Guards against over-collapsing the selector space. C3 + lab attribution
// both cite #main; a second shift on aside#sidebar is a different element
// and must still surface as its own C6 finding.
process.stdout.write('C6: distinct ids do NOT dedupe\n');
{
  const rumBundle = mkRumBundle({
    clsP75: 0.15,
    clsTop: [{ value: 0.11, url: PAGE_URL, target: '#main', timestamp: '2026-04-15T12:00:00Z' }],
  });
  const run = mkRun({
    clsValue: 0.10,
    clsAttr: { largestShiftTarget: '#main', loadState: 'complete' },
  });
  run.cwv.cls.shifts = [
    { value: 0.08, startTime: 7319, hadRecentInput: false,
      sources: [{ target: 'aside#sidebar', previousRect: null, currentRect: { width: 300, height: 800 } }] },
  ];
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));
  assert('C6 fires for aside#sidebar (different element than #main)', c6.length >= 1);
}

// ---------------------------------------------------------------------------
// Regression: HAR URLs containing `"` or `\` must be CSS-escaped before they
// are interpolated into double-quoted attribute selectors. Mirrors the fix
// landed in html-parse.js (commit 7ddd13b).
// ---------------------------------------------------------------------------

process.stdout.write('Regression: CSS-escape HAR URLs in patches.markup selectors\n');
{
  // C1: script URL with embedded `"` and `\` must be escaped in `script[src*="..."]`.
  const nastyScriptUrl = 'https://www.googletagmanager.com/gtm.js?q="\\evil';
  const rumBundle = mkRumBundle({
    inpP75: 550,
    inpTop: [{
      value: 620, url: PAGE_URL, target: 'button.cta',
      interactionType: 'click', timestamp: '2026-04-15T12:00:00Z',
    }],
  });
  const gtm = {
    url: nastyScriptUrl, type: 'script', domain: 'www.googletagmanager.com',
    transferSize: 55000, duration: 400, startTime: 800,
    priority: 'Low', initiatorType: 'script', renderBlockingStatus: 'non-blocking',
  };
  const run = mkRun({
    inpValue: 480,
    inpAttr: { interactionTarget: 'BUTTON.cta' },
    resources: { preLCP: [gtm], postLCP: [], renderBlocking: [], byType: { img: [] } },
  });
  const out = correlateChains({ rumBundle, launcherOutput: mkLauncherOutput(run) });
  const c1 = out.findings.find((f) => f.id.includes('-c1-'));
  assert('C1 emits finding for nasty URL', !!c1);
  if (c1 && c1.patches && Array.isArray(c1.patches.markup) && c1.patches.markup.length) {
    const sel = c1.patches.markup[0].selector;
    assert('C1 selector escapes `"` (contains \\")', sel.includes('\\"'),
      `selector=${JSON.stringify(sel)}`);
    assert('C1 selector escapes `\\` (contains \\\\)', sel.includes('\\\\'),
      `selector=${JSON.stringify(sel)}`);
    // The selector must still be a well-formed [attr*="..."] — i.e. exactly
    // two unescaped double quotes wrapping the value.
    const unescapedQuotes = (sel.match(/(^|[^\\])"/g) || []).length;
    assert('C1 selector has exactly 2 unescaped quotes', unescapedQuotes === 2,
      `got ${unescapedQuotes}; selector=${JSON.stringify(sel)}`);
  }

  // C2: image URL fallback selector must also be escaped. Force the fallback
  // by omitting labTarget and rumSample.target.
  const nastyImgUrl = 'https://www.example.com/hero.jpg?q="\\x';
  const rumBundle2 = mkRumBundle({
    lcpP75: 3800,
    lcpTop: [{ value: 4100, url: PAGE_URL, target: null, timestamp: '2026-04-15T12:00:00Z' }],
  });
  const hero = {
    url: nastyImgUrl, type: 'img', domain: DOMAIN,
    transferSize: 320000, duration: 900, startTime: 2400,
    priority: 'Low', initiatorType: 'img', renderBlockingStatus: 'non-blocking',
  };
  const run2 = mkRun({
    lcpValue: 3500,
    lcpAttr: { url: nastyImgUrl, resourceLoadDelay: 1800, elementRenderDelay: 200, timeToFirstByte: 300 },
    resources: { preLCP: [hero], postLCP: [], renderBlocking: [], byType: { img: [hero] } },
  });
  const out2 = correlateChains({ rumBundle: rumBundle2, launcherOutput: mkLauncherOutput(run2) });
  const c2 = out2.findings.find((f) => f.id.includes('-c2-'));
  assert('C2 emits finding for nasty URL', !!c2);
  if (c2 && c2.patches && Array.isArray(c2.patches.markup) && c2.patches.markup.length) {
    const sel = c2.patches.markup[0].selector;
    // Only assert escape if we hit the fallback `img[src="..."]` branch —
    // labTarget/rumSample.target wins otherwise.
    if (sel.startsWith('img[src="')) {
      assert('C2 fallback selector escapes `"`', sel.includes('\\"'),
        `selector=${JSON.stringify(sel)}`);
      assert('C2 fallback selector escapes `\\`', sel.includes('\\\\'),
        `selector=${JSON.stringify(sel)}`);
      const unescapedQuotes = (sel.match(/(^|[^\\])"/g) || []).length;
      assert('C2 fallback selector has exactly 2 unescaped quotes', unescapedQuotes === 2,
        `got ${unescapedQuotes}; selector=${JSON.stringify(sel)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Regression: C6 attribution must cite the GROWN element, not the MOVED victim.
// Mirrors the the pets-site case 2026-04-17 case: an async promo banner was injected
// into <header>; the header grew, and <main> slid down as a consequence.
// Pre-fix, C6 cited main#main (first/widest source that moved) — any patch
// reserving min-height on <main> is a no-op because <main>'s height didn't
// change. The grown element (header) is the correct attribution target.
// ---------------------------------------------------------------------------

process.stdout.write('C6: attribution = grown element (header), not moved victim (main)\n');
{
  const run = mkRun({
    clsValue: 0.092,
    clsAttr: { largestShiftTarget: 'main#main', loadState: 'complete' },
  });
  // Baseline: <header> y=0 h=80, <main> y=80 h=1200.
  // After promo banner injects: <header> y=0 h=160 (+80), <main> y=160 h=1200 (moved +80).
  run.cwv.cls.shifts = [
    {
      value: 0.092,
      startTime: 1200,
      hadRecentInput: false,
      sources: [
        // Order mimics real browser output: moved victim often comes first.
        {
          target: 'main#main',
          previousRect: { x: 0, y: 80, width: 1280, height: 1200 },
          currentRect: { x: 0, y: 160, width: 1280, height: 1200 },
        },
        {
          target: 'header.site-header',
          previousRect: { x: 0, y: 0, width: 1280, height: 80 },
          currentRect: { x: 0, y: 0, width: 1280, height: 160 },
        },
      ],
    },
  ];
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));
  assert('C6 emits exactly 1 finding', c6.length === 1, `got ${c6.length}`);
  if (c6.length) {
    const data = c6[0].evidence[0].data;
    assert('C6 attribution.target is the grown element (header)',
      data.target === 'header.site-header', `got ${data.target}`);
    assert('C6 evidence.movedTarget preserves the victim (main)',
      data.movedTarget === 'main#main', `got ${data.movedTarget}`);
    assert('C6 shiftWithoutGrowth = false (header grew)',
      data.shiftWithoutGrowth === false);
    assert('C6 rootCause = true (G3 — runtime-confirmed grown source is authoritative)',
      c6[0].rootCause === true, `got ${c6[0].rootCause}`);
    assert('C6 confidence at perf_observer cap for confirmed shift',
      c6[0].confidence === 0.85, `got ${c6[0].confidence}`);
    assert('C6 patch targets the grown element',
      c6[0].patches && c6[0].patches.markup
      && c6[0].patches.markup[0].selector === 'header.site-header');
    assert('C6 patch reserves min-height matching grown height (160px)',
      c6[0].patches.markup[0].attrs.style === 'min-height:160px');
    validateAll(c6, 'C6 grown-vs-moved');
  }
}

// ---------------------------------------------------------------------------
// Regression: when NO source grew (pure repositioning — e.g. explicit margin
// change, transform animation), C6 must fall back to the widest-rect source
// and flag `shiftWithoutGrowth=true` so the reader knows this isn't the
// typical injection-shift pattern.
// ---------------------------------------------------------------------------

process.stdout.write('C6: fallback when no source grew (pure repositioning)\n');
{
  const run = mkRun({
    clsValue: 0.10,
    clsAttr: { largestShiftTarget: 'div.block-a', loadState: 'complete' },
  });
  run.cwv.cls.shifts = [
    {
      value: 0.10,
      startTime: 1500,
      hadRecentInput: false,
      sources: [
        // Both moved down ~50px but neither grew.
        {
          target: 'div.block-a',
          previousRect: { x: 0, y: 100, width: 800, height: 300 },
          currentRect: { x: 0, y: 150, width: 800, height: 300 },
        },
        {
          target: 'div.block-b',
          previousRect: { x: 0, y: 400, width: 400, height: 200 },
          currentRect: { x: 0, y: 450, width: 400, height: 200 },
        },
      ],
    },
  ];
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));
  assert('C6 emits exactly 1 finding (no-growth fallback)', c6.length === 1, `got ${c6.length}`);
  if (c6.length) {
    const data = c6[0].evidence[0].data;
    assert('C6 shiftWithoutGrowth = true (no source grew)',
      data.shiftWithoutGrowth === true);
    assert('C6 rootCause = false (G3 — pure repositioning is a victim, cause unidentified)',
      c6[0].rootCause === false, `got ${c6[0].rootCause}`);
    assert('C6 attribution falls back to widest-rect source',
      data.target === 'div.block-a', `got ${data.target}`);
    assert('C6 cause text mentions "shift-without-growth"',
      /shift-without-growth/i.test(c6[0].cause),
      `cause=${JSON.stringify(c6[0].cause)}`);
    validateAll(c6, 'C6 no-growth');
  }
}

// ---------------------------------------------------------------------------
// Regression: when multiple sources grew, prefer the one closest to the
// document start (smallest previousRect.y). Injection banners typically live
// near the top; picking the earliest grown element matches the real cause.
// ---------------------------------------------------------------------------

process.stdout.write('C6: multi-grown picks earliest (smallest previousRect.y)\n');
{
  const run = mkRun({
    clsValue: 0.15,
    clsAttr: { largestShiftTarget: 'section.later', loadState: 'complete' },
  });
  run.cwv.cls.shifts = [
    {
      value: 0.15,
      startTime: 2000,
      hadRecentInput: false,
      sources: [
        // Larger growth, but lower down the page — NOT the preferred target.
        {
          target: 'section.later',
          previousRect: { x: 0, y: 600, width: 1280, height: 300 },
          currentRect: { x: 0, y: 700, width: 1280, height: 500 },
        },
        // Smaller growth, but at the very top — this is the earliest cause.
        {
          target: 'header.promo',
          previousRect: { x: 0, y: 0, width: 1280, height: 80 },
          currentRect: { x: 0, y: 0, width: 1280, height: 140 },
        },
      ],
    },
  ];
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));
  assert('C6 picks earliest grown source (header.promo)',
    c6.length === 1 && c6[0].evidence[0].data.target === 'header.promo',
    `got ${c6[0] && c6[0].evidence[0].data.target}`);
}

// ---------------------------------------------------------------------------
// V5: animated-reveal CLS mechanism classifier (detectAnimatedReveals + C6 wiring)
// ---------------------------------------------------------------------------

// The the news-site case consent banner: jQuery .show(duration) tweens its size across many
// frames — monotonic width+height growth over consecutive layout shifts.
const BANNER = 'div.t004-cookie.aem-GridColumn > section.cookies__container.font-lato';
function bannerGrowthShifts() {
  const frames = [
    [0.0011, 26212, [110, 35], [353, 114]],
    [0.0093, 26236, [353, 114], [696, 225]],
    [0.0455, 26259, [696, 225], [1069, 346]],
    [0.0341, 26274, [1069, 346], [1269, 411]],
    [0.0340, 26290, [1269, 411], [1426, 462]],
    [0.0213, 26307, [1426, 462], [1514, 490]],
  ];
  return frames.map(([value, startTime, [pw, ph], [cw, ch]]) => ({
    value, startTime, hadRecentInput: false,
    sources: [{ target: BANNER, previousRect: { x: 0, y: 0, width: pw, height: ph }, currentRect: { x: 0, y: 0, width: cw, height: ch } }],
  }));
}

process.stdout.write('V5: detectAnimatedReveals (pure)\n');
{
  const reveals = detectAnimatedReveals(bannerGrowthShifts());
  const r = reveals.get(BANNER);
  assert('detects the banner as an animated reveal', !!r);
  assert('signal is monotonic-growth', r && r.signal === 'monotonic-growth', r && r.signal);
  assert('captures the FINAL size (1514×490), not a mid-animation frame',
    r && r.toRect.w === 1514 && r.toRect.h === 490, r && JSON.stringify(r.toRect));
  assert('counts all 6 growth frames', r && r.steps === 6, r && String(r.steps));
}

process.stdout.write('V5: detectAnimatedReveals — appears from display:none (0×0), multi-frame\n');
{
  const shifts = [
    { value: 0.05, startTime: 1000, hadRecentInput: false, sources: [{ target: 'div.tab-panel', previousRect: { width: 0, height: 0 }, currentRect: { width: 800, height: 120 } }] },
    { value: 0.04, startTime: 1020, hadRecentInput: false, sources: [{ target: 'div.tab-panel', previousRect: { width: 800, height: 120 }, currentRect: { width: 800, height: 240 } }] },
  ];
  const r = detectAnimatedReveals(shifts).get('div.tab-panel');
  assert('detects display:none→flex reveal', !!r);
  assert('signal is appears-from-zero', r && r.signal === 'appears-from-zero', r && r.signal);
}

process.stdout.write('V5: detectAnimatedReveals — negative cases (no false positives)\n');
{
  // A single one-time grow from height 0 (the generic unsized-element case) is NOT
  // an animated reveal — this is what the existing C6 reserve-space advice covers.
  const oneShot = [{ value: 0.4, startTime: 100, hadRecentInput: false, sources: [{ target: 'div.hero', previousRect: { width: 300, height: 0 }, currentRect: { width: 300, height: 400 } }] }];
  assert('single grow-from-0 is NOT a reveal', detectAnimatedReveals(oneShot).size === 0);

  // A flat element repositioned across frames (the news-site case close button, 64×64 each) — no growth.
  const flat = [1, 2, 3, 4, 5].map((i) => ({ value: 0.001, startTime: 100 * i, hadRecentInput: false, sources: [{ target: 'button.close', previousRect: { width: 64, height: 64 }, currentRect: { width: 64, height: 64 } }] }));
  assert('flat (no net growth) is NOT a reveal', detectAnimatedReveals(flat).size === 0);

  // Grow-then-shrink is not monotonic.
  const wobble = [[100, 200], [200, 400], [150, 300]].map(([w, h], i) => ({ value: 0.04, startTime: 100 * i, hadRecentInput: false, sources: [{ target: 'div.wobble', previousRect: { width: 0, height: 0 }, currentRect: { width: w, height: h } }] }));
  const wob = detectAnimatedReveals(wobble).get('div.wobble');
  // first prev is 0×0 so it still qualifies via appears-from-zero, but must NOT claim monotonic-growth.
  assert('non-monotonic does not claim monotonic-growth', !wob || wob.signal !== 'monotonic-growth', wob && wob.signal);

  // input-driven shifts are ignored.
  const recentInput = bannerGrowthShifts().map((s) => ({ ...s, hadRecentInput: true }));
  assert('hadRecentInput frames are ignored', detectAnimatedReveals(recentInput).size === 0);
}

process.stdout.write('V5: C6 tags an animated reveal + recommends transform/opacity + reserves FINAL size\n');
{
  const run = mkRun({ clsValue: 0.27, clsAttr: { loadState: 'complete' } });
  run.cwv.cls.shifts = [
    ...bannerGrowthShifts(),
    // a one-shot late-injected promo that grows once — must keep the standard rec.
    { value: 0.06, startTime: 9000, hadRecentInput: false, sources: [{ target: 'header.promo', previousRect: { x: 0, y: 0, width: 1280, height: 80 }, currentRect: { x: 0, y: 0, width: 1280, height: 140 } }] },
  ];
  const out = correlateChains({ launcherOutput: mkLauncherOutput(run) });
  const c6 = out.findings.filter((f) => f.id.includes('-c6-'));

  const banner = c6.find((f) => f.evidence[0].data.target === BANNER);
  assert('banner emits exactly one C6 finding (dedup across frames)',
    c6.filter((f) => f.evidence[0].data.target === BANNER).length === 1);
  assert('banner finding tagged mechanism=animated-reveal', banner && banner.evidence[0].data.mechanism === 'animated-reveal');
  assert('banner revealSignal=monotonic-growth', banner && banner.evidence[0].data.revealSignal === 'monotonic-growth');
  assert('banner recommendation pushes transform/opacity', banner && /transform/.test(banner.recommendation) && /opacity/.test(banner.recommendation));
  assert('banner recommendation warns off width/height/display', banner && /width.*height.*display|display.*property|\.show\(/.test(banner.recommendation), banner && banner.recommendation);
  assert('banner patch reserves the FINAL height (490px), not a mid-frame',
    banner && banner.patches.markup[0].attrs.style === 'min-height:490px',
    banner && banner.patches.markup[0].attrs.style);
  assert('banner is still rootCause + confidence 0.85', banner && banner.rootCause === true && banner.confidence === 0.85);

  const promo = c6.find((f) => f.evidence[0].data.target === 'header.promo');
  assert('one-shot promo is NOT tagged animated-reveal', promo && promo.evidence[0].data.mechanism === undefined);
  assert('one-shot promo keeps the reserve-space recommendation', promo && /[Rr]eserve/.test(promo.recommendation), promo && promo.recommendation);
  validateAll(c6, 'V5-C6');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const fl of failures) process.stdout.write(`  - ${fl}\n`);
  process.exit(1);
}
process.exit(0);
