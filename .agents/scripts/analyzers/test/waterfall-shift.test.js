#!/usr/bin/env node

/**
 * Sanity test for waterfall-shift.js.
 *
 * Constructs a minimal fake launcher output that should trigger each of the
 * five heuristics, calls analyzeWaterfall, validates every returned finding
 * with validateFinding(), and prints PASS/FAIL per heuristic.
 *
 * Exit 0 on success, non-zero otherwise.
 */

import { analyzeWaterfall } from '../waterfall-shift.js';
import { validateFinding } from '../../finding-schema.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const LCP_TIME = 3500;
const HERO_URL = 'https://example.com/hero.jpg';

const heroImg = {
  url: HERO_URL,
  type: 'img',
  transferSize: 180000,
  duration: 700,
  renderBlockingStatus: 'non-blocking',
  priority: 'Low',
  initiatorType: 'img',
  startTime: 2400,
  responseEnd: 3100,
  domain: 'example.com',
};

const rbAnalytics = {
  url: 'https://www.google-analytics.com/analytics.js',
  type: 'script',
  transferSize: 45000,
  duration: 400,
  renderBlockingStatus: 'blocking',
  priority: 'Low',
  initiatorType: 'script',
  startTime: 300,
  responseEnd: 700,
  domain: 'www.google-analytics.com',
};

// 4-hop chain on same origin, each starts ~20ms after previous ends.
function mkChainNode(i, startTime) {
  return {
    url: `https://example.com/chain-${i}.js`,
    type: 'script',
    transferSize: 15000,
    duration: 200,
    renderBlockingStatus: 'non-blocking',
    priority: 'High',
    initiatorType: 'script',
    startTime,
    responseEnd: startTime + 200,
    domain: 'example.com',
  };
}

const chainNodes = [
  mkChainNode(1, 400),
  mkChainNode(2, 620),   // gap 20ms after prior end (600)
  mkChainNode(3, 840),
  mkChainNode(4, 1060),
];

// Large high-priority non-blocking script for H4.
const bigScript = {
  url: 'https://example.com/big-bundle.js',
  type: 'script',
  transferSize: 220000,
  duration: 900,
  renderBlockingStatus: 'non-blocking',
  priority: 'High',
  initiatorType: 'script',
  startTime: 900,
  responseEnd: 1800,
  domain: 'example.com',
};

const preLCP = [rbAnalytics, ...chainNodes, bigScript, heroImg];
const renderBlocking = [rbAnalytics];
const postLCP = [];

const fakeLauncherOutput = {
  url: 'https://example.com/',
  profile: 'mobile-slow4g-4xcpu',
  runs: [
    {
      timestamp: new Date().toISOString(),
      cwv: {
        lcp: {
          value: LCP_TIME,
          rating: 'poor',
          attribution: {
            target: 'main > section > img.hero',
            url: HERO_URL,
            resourceLoadDelay: 1800,
            elementRenderDelay: 200,
            lcpEntry: { startTime: LCP_TIME },
          },
        },
      },
      resources: { preLCP, postLCP, renderBlocking, all: preLCP.concat(postLCP) },
    },
  ],
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const { findings, summary } = analyzeWaterfall(fakeLauncherOutput);

let failed = 0;
function report(name, pass, detail) {
  const tag = pass ? 'PASS' : 'FAIL';
  process.stdout.write(`${tag} ${name}${detail ? ' — ' + detail : ''}\n`);
  if (!pass) failed++;
}

// Check every finding validates.
let allValid = true;
for (const f of findings) {
  const r = validateFinding(f);
  if (!r.valid) {
    allValid = false;
    process.stderr.write(`INVALID ${f.id}: ${r.errors.join('; ')}\n`);
  }
}
report('all findings validate against schema', allValid, `${findings.length} total`);

// Per-heuristic coverage.
function hasHeuristic(tag) {
  return findings.some((f) => f.id.includes(`-${tag}-`));
}

report('H1 shift-left emitted', hasHeuristic('h1'));
report('H2 shift-right emitted (GA render-blocking)', hasHeuristic('h2'));
report('H3 chain depth emitted (4-hop chain)', hasHeuristic('h3'));
report('H4 main-thread blocking emitted (220KB script)', hasHeuristic('h4'));
report('H5 priority mismatch emitted (Low-priority hero)', hasHeuristic('h5'));

// Summary sanity.
report('summary is a non-empty string', typeof summary === 'string' && summary.length > 0, summary);

// Check that H5 produced a markup patch with fetchpriority=high.
const h5 = findings.find((f) => f.id.includes('-h5-'));
if (h5) {
  const hasFetchpri = h5.patches && Array.isArray(h5.patches.markup)
    && h5.patches.markup.some((m) => m.attrs && m.attrs.fetchpriority === 'high');
  report('H5 patch sets fetchpriority=high', hasFetchpri);
} else {
  report('H5 patch sets fetchpriority=high', false, 'H5 missing');
}

// Check that H2 has status "proposed" (GA 45KB → 9ms saved → below floor → rejected).
// Since 45KB * 0.2 / 1000 = 9ms < 200ms, H2 will actually emit rejected. That's correct.
const h2 = findings.find((f) => f.id.includes('-h2-'));
if (h2) {
  const expectedStatus = h2.impactReduction.valueMs < 200 ? 'rejected' : 'proposed';
  report('H2 status matches MIN_ACTIONABLE_IMPACT gate', h2.status === expectedStatus,
    `status=${h2.status}, valueMs=${h2.impactReduction.valueMs}`);
}

// Check source-tier confidence cap.
const overCap = findings.filter((f) => f.confidence > 0.85 + 1e-9);
report('no finding exceeds perf_observer confidence cap (0.85)', overCap.length === 0);

// ---------------------------------------------------------------------------
// ROADMAP item 10 regressions — H1 bandwidth-aware guards
// ---------------------------------------------------------------------------

function makeH1Fixture({ heroStart, fcp, lcp, rbCssBytes, hasUrl = true }) {
  const heroUrl = 'https://example.com/hero-p.jpg';
  const hero = {
    url: heroUrl,
    type: 'img',
    transferSize: 41000,
    duration: 400,
    renderBlockingStatus: 'non-blocking',
    priority: 'High',
    initiatorType: 'img',
    startTime: heroStart,
    responseEnd: heroStart + 400,
    domain: 'example.com',
  };
  const rbCss = {
    url: 'https://example.com/styles.css',
    type: 'css',
    transferSize: rbCssBytes,
    duration: 400,
    renderBlockingStatus: 'blocking',
    priority: 'VeryHigh',
    initiatorType: 'link',
    startTime: 300,
    responseEnd: 700,
    domain: 'example.com',
  };
  return {
    url: 'https://example.com/',
    profile: 'mobile-slow4g-4xcpu',
    runs: [{
      timestamp: new Date().toISOString(),
      cwv: {
        lcp: {
          value: lcp,
          rating: 'poor',
          attribution: {
            target: 'div.hero>picture>img',
            url: hasUrl ? heroUrl : undefined,
            resourceLoadDelay: Math.max(0, heroStart - 280),
            resourceLoadDuration: 400,
            elementRenderDelay: Math.max(0, lcp - (heroStart + 400)),
            lcpEntry: { startTime: lcp },
          },
        },
        fcp: { value: fcp, rating: 'poor' },
      },
      resources: {
        preLCP: [rbCss, hero],
        postLCP: [],
        renderBlocking: [rbCss],
        all: [rbCss, hero],
      },
    }],
  };
}

// Case 1: the pets-site case-shaped regression — LCP img starts before FCP → rejected.
{
  const out = analyzeWaterfall(makeH1Fixture({
    heroStart: 1989, fcp: 2047, lcp: 3039, rbCssBytes: 37615,
  }));
  const h1 = out.findings.filter((f) => f.id.includes('-h1-'));
  report('H1 the pets-site case: emits exactly one H1 finding', h1.length === 1, `got ${h1.length}`);
  const f = h1[0];
  if (f) {
    report('H1 the pets-site case: status=rejected (pre-FCP discovery)', f.status === 'rejected', `status=${f.status}`);
    report('H1 the pets-site case: impact valueMs=0', f.impactReduction && f.impactReduction.valueMs === 0,
      `valueMs=${f.impactReduction && f.impactReduction.valueMs}`);
    report('H1 the pets-site case: cause mentions FCP', /FCP/i.test(f.cause || ''), f.cause ? f.cause.slice(0, 100) : 'no cause');
    report('H1 the pets-site case: no preload recommendation issued',
      !(f.patches && f.patches.preloads && f.patches.preloads.length > 0));
  }
}

// Case 2: heavy render-blocking but image starts after FCP → fires with
// de-rated confidence and bandwidth-capped savings.
{
  const out = analyzeWaterfall(makeH1Fixture({
    heroStart: 2200, fcp: 1800, lcp: 3400, rbCssBytes: 80 * 1024,
  }));
  const h1 = out.findings.filter((f) => f.id.includes('-h1-'));
  report('H1 heavy-RB: emits exactly one H1 finding', h1.length === 1, `got ${h1.length}`);
  const f = h1[0];
  if (f) {
    report('H1 heavy-RB: status=proposed', f.status === 'proposed', `status=${f.status}`);
    report('H1 heavy-RB: confidence de-rated to 0.55', Math.abs(f.confidence - 0.55) < 1e-6,
      `confidence=${f.confidence}`);
    report('H1 heavy-RB: cause mentions bandwidth competition',
      /render-blocking|bandwidth|compete/i.test(f.cause || ''));
    const rld = 2200 - 280;
    const bwTransferMs = Math.round((80 * 1024) / 204.8);
    const expectedCap = rld - bwTransferMs;
    report('H1 heavy-RB: savedMs capped at bandwidth estimate',
      f.impactReduction.valueMs <= expectedCap + 5 && f.impactReduction.valueMs >= 0,
      `valueMs=${f.impactReduction.valueMs}, expectedCap≈${expectedCap}`);
  }
}

// Case 3: light render-blocking and image starts after FCP → H1 fires normally
// with full 0.75 confidence.
{
  const out = analyzeWaterfall(makeH1Fixture({
    heroStart: 2200, fcp: 1800, lcp: 3400, rbCssBytes: 10 * 1024,
  }));
  const h1 = out.findings.filter((f) => f.id.includes('-h1-'));
  report('H1 light-RB: emits exactly one H1 finding', h1.length === 1, `got ${h1.length}`);
  const f = h1[0];
  if (f) {
    report('H1 light-RB: status=proposed', f.status === 'proposed', `status=${f.status}`);
    report('H1 light-RB: confidence stays at 0.75', Math.abs(f.confidence - 0.75) < 1e-6,
      `confidence=${f.confidence}`);
    report('H1 light-RB: preload patch included',
      !!(f.patches && f.patches.preloads && f.patches.preloads.length > 0));
  }
}

// Case 4: render-bound / JS-injected LCP image (the petplace case 2026-07-23) —
// hero discovered at 13435ms, long after FCP (570ms) and ~86% of a 15690ms LCP.
// Guard (d): downgrade to a rejected hypothesis, no preload, zero impact.
{
  const out = analyzeWaterfall(makeH1Fixture({
    heroStart: 13435, fcp: 570, lcp: 15690, rbCssBytes: 10 * 1024,
  }));
  const h1 = out.findings.filter((f) => f.id.includes('-h1-'));
  report('H1 render-bound: emits exactly one H1 finding', h1.length === 1, `got ${h1.length}`);
  const f = h1[0];
  if (f) {
    report('H1 render-bound: status=rejected (JS-injected LCP image)', f.status === 'rejected', `status=${f.status}`);
    report('H1 render-bound: rootCause=false', f.rootCause === false, `rootCause=${f.rootCause}`);
    report('H1 render-bound: impact valueMs=0', f.impactReduction && f.impactReduction.valueMs === 0,
      `valueMs=${f.impactReduction && f.impactReduction.valueMs}`);
    report('H1 render-bound: no preload recommendation issued',
      !(f.patches && f.patches.preloads && f.patches.preloads.length > 0));
    report('H1 render-bound: cause explains JS-injection / render-bound',
      /inject|JS|render-bound|preload scanner/i.test(f.cause || ''), f.cause ? f.cause.slice(0, 120) : 'no cause');
    report('H1 render-bound: recommendation routes to unused-code / bundling',
      /unused-code|bundling|render-critical/i.test(f.recommendation || ''));
  }
}

// Case 5: physical cap — a preload can never save more than (LCP − FCP).
// A network-late (not JS-injected) image: discovery is within FCP+2000ms so
// Guard (d) stays off, but the raw (startTime−100) ceiling (3300ms) exceeds
// LCP−FCP (2500ms), so the physical cap must clamp savings to 2500ms.
{
  const heroStart = 3400; const fcp = 1500; const lcp = 4000;
  const out = analyzeWaterfall(makeH1Fixture({
    heroStart, fcp, lcp, rbCssBytes: 1 * 1024,
  }));
  const h1 = out.findings.filter((f) => f.id.includes('-h1-'));
  const f = h1[0];
  report('H1 physical cap: fires as a normal proposed preload (Guard d off)',
    !!(f && f.status === 'proposed'), f ? `status=${f.status}` : 'no finding');
  if (f && f.status === 'proposed') {
    report('H1 physical cap: savedMs clamped to LCP−FCP',
      f.impactReduction.valueMs <= (lcp - fcp) && f.impactReduction.valueMs < (heroStart - 100),
      `valueMs=${f.impactReduction.valueMs}, cap=${lcp - fcp}, uncapped≈${heroStart - 100}`);
  }
}

process.stdout.write('\n' + summary + '\n');
process.stdout.write(`\n${failed === 0 ? 'ALL TESTS PASS' : failed + ' TEST(S) FAILED'}\n`);
process.exit(failed === 0 ? 0 : 1);
