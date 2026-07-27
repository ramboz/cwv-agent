#!/usr/bin/env node

/**
 * Waterfall-shift analyzer.
 *
 * Consumes the JSON output of `.agents/scripts/launcher.js` and produces
 * Findings (per .agents/references/topics/finding-schema.md) that recommend
 * "shifting" resources relative to LCP:
 *   - shift-left  → preload resources discovered late but needed pre-LCP
 *   - shift-right → defer render-blocking waste discovered pre-LCP
 *
 * Five heuristics (see .agents/references/topics/waterfall-shift.md):
 *   H1  shift-left (preload candidates)
 *   H2  shift-right (defer candidates)
 *   H3  chain depth (serial request cascade)
 *   H4  main-thread pre-LCP blocking JS
 *   H5  LCP resource priority mismatch
 *
 * Usage:
 *   import { analyzeWaterfall } from './waterfall-shift.js';
 *   const out = analyzeWaterfall(launcherOutput);
 *
 * CLI:
 *   node waterfall-shift.js <launcher-output.json>
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateFinding,
  SOURCE_TIERS,
  MIN_IMPACT,
  deriveSeverity,
} from '../finding-schema.js';
import { getProfile } from '../profiles.js';
import { cssEscapeAttrValue } from '../selector-utils.js';

// ---------------------------------------------------------------------------
// Domain / category classifiers (cross-reference request-chains.md DEFERRABLE)
// ---------------------------------------------------------------------------

// Deferrable third-party domains: analytics, consent, monitoring, chat, social.
const DEFERRABLE_DOMAIN_PATTERNS = [
  // Analytics
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)segment\.(com|io)$/i,
  /(^|\.)mixpanel\.com$/i,
  /(^|\.)amplitude\.com$/i,
  /(^|\.)adobedtm\.com$/i,
  /(^|\.)omtrdc\.net$/i,
  /(^|\.)demdex\.net$/i,
  // Consent / privacy
  /(^|\.)onetrust\.com$/i,
  /(^|\.)cookielaw\.org$/i,
  /(^|\.)trustarc\.com$/i,
  /(^|\.)cookiebot\.com$/i,
  // Monitoring / errors
  /(^|\.)sentry\.io$/i,
  /(^|\.)datadoghq\.com$/i,
  /(^|\.)datadog-rum\.com$/i,
  /(^|\.)newrelic\.com$/i,
  /(^|\.)nr-data\.net$/i,
  /(^|\.)rollbar\.com$/i,
  // Session replay
  /(^|\.)hotjar\.com$/i,
  /(^|\.)fullstory\.com$/i,
  /(^|\.)clarity\.ms$/i,
  /(^|\.)contentsquare\.net$/i,
  // Chat
  /(^|\.)intercom\.io$/i,
  /(^|\.)intercomcdn\.com$/i,
  /(^|\.)drift\.com$/i,
  /(^|\.)zendesk\.com$/i,
  // Social embeds / pixels
  /(^|\.)facebook\.(com|net)$/i,
  /(^|\.)connect\.facebook\.net$/i,
  /(^|\.)licdn\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
];

function isDeferrableDomain(domain) {
  if (!domain) return false;
  return DEFERRABLE_DOMAIN_PATTERNS.some((re) => re.test(domain));
}

function safeDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const LARGE_JS_BYTES = 50 * 1024;      // H4 threshold
const CHAIN_DEPTH_FLAG = 3;            // H3 threshold
const RTT_MS_PER_HOP = 150;            // H3 per-hop cost (slow-4G baseline)
const LATE_DISCOVERY_MS = 500;         // H1: "started >500ms in" = late
const HEAVY_RB_THRESHOLD_BYTES = 50 * 1024;  // H1 bandwidth guard — see ROADMAP item 10
// H1 Guard (d): a render-bound / JS-injected LCP image. An <img> present in the
// initial HTML is found by the preload scanner near t≈0; an LCP image whose
// discovery (startTime) lands well after FCP was injected by JS (framework
// render), so a <head> preload front-loads the bytes but cannot advance the
// JS-gated element insertion — LCP stays put (or regresses as the preload steals
// priority from the render-critical JS). See the petplace case 2026-07-23:
// preload drove resourceLoadDelay 13015→5ms yet LCP +231ms (elementRenderDelay
// 1→13215ms). Both conditions must hold to avoid flagging a network-late but
// HTML-discoverable image (which a preload *would* help).
const RENDER_BOUND_DISCOVERY_MARGIN_MS = 2000; // discovery must be >2s past FCP
const RENDER_BOUND_LCP_FRACTION = 0.5;         // …and account for ≥50% of LCP
const LCP_METRIC = 'LCP';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow() { return new Date().toISOString(); }

function round(n) {
  if (typeof n !== 'number' || !isFinite(n)) return 0;
  return Math.round(n);
}

function capConfidence(source, desired) {
  const tier = SOURCE_TIERS[source];
  const cap = tier ? tier.maxConfidence : 0.5;
  return Math.min(desired, cap);
}

function buildEvidenceResourceTiming(r) {
  return {
    kind: 'resource-timing',
    data: {
      url: r.url,
      startTime: round(r.startTime),
      transferSize: r.transferSize || 0,
      duration: round(r.duration),
      renderBlockingStatus: r.renderBlockingStatus || null,
      priority: r.priority || null,
      type: r.type || null,
    },
  };
}

function buildEvidenceLcpAttribution(run) {
  const lcp = run.cwv && run.cwv.lcp ? run.cwv.lcp : {};
  const attr = lcp.attribution || {};
  const lcpEntry = attr.lcpEntry || {};
  return {
    kind: 'cwv-attribution',
    metric: LCP_METRIC,
    data: {
      lcpValueMs: round(lcp.value),
      target: attr.target || null,
      lcpStartTime: round(lcpEntry.startTime || lcpEntry.renderTime || 0),
      resourceLoadDelay: round(attr.resourceLoadDelay),
      elementRenderDelay: round(attr.elementRenderDelay),
      url: attr.url || null,
    },
  };
}

/**
 * Effective download bandwidth in bytes/ms for the given throttling profile.
 * Returns Infinity when throttling is disabled; falls back to the
 * mobile-slow4g-4xcpu value (204.8 bytes/ms) for unknown profiles, since that
 * is the default launcher profile and the one most likely to expose
 * bandwidth-constrained LCP behaviour.
 */
function effectiveBandwidthBytesPerMs(profileName) {
  try {
    const p = getProfile(profileName);
    if (!p || p.download === -1) return Infinity;
    return p.download / 1000;
  } catch {
    return 204.8;
  }
}

/**
 * Sum transferSize of render-blocking resources that start before LCP.
 * Used by H1 to estimate the bandwidth competing with a proposed preload.
 */
function renderBlockingBytesBeforeLcp(run) {
  const rb = (run.resources && run.resources.renderBlocking) || [];
  const lcp = run.cwv && run.cwv.lcp ? run.cwv.lcp : null;
  const lcpTime = lcp && typeof lcp.value === 'number' ? lcp.value : Infinity;
  let total = 0;
  for (const r of rb) {
    if (!r) continue;
    if (typeof r.startTime === 'number' && r.startTime >= lcpTime) continue;
    total += r.transferSize || 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Heuristic 1: Shift-left (preload candidates)
// ---------------------------------------------------------------------------

function detectLcpTargetMatch(resource, lcpAttr) {
  if (!resource || !lcpAttr) return false;
  if (lcpAttr.url && resource.url && lcpAttr.url === resource.url) return true;
  // web-vitals attribution rarely fills a resource URL for images; fall back to
  // selector-hint match: if the target selector references `img` and resource type is img,
  // and the resource URL starts with the page origin, treat it as a likely LCP image only
  // when it is the largest img pre-LCP (caller scopes this).
  return false;
}

function h1ShiftLeft(run, ctx) {
  const findings = [];
  const preLCP = (run.resources && run.resources.preLCP) || [];
  const renderBlocking = (run.resources && run.resources.renderBlocking) || [];
  const lcp = run.cwv && run.cwv.lcp ? run.cwv.lcp : null;
  if (!lcp || typeof lcp.value !== 'number') return findings;
  const lcpAttr = lcp.attribution || {};
  const fcp = run.cwv && run.cwv.fcp ? run.cwv.fcp : null;
  const fcpValue = fcp && typeof fcp.value === 'number' ? fcp.value : null;

  // Bandwidth-competition context (ROADMAP item 10).
  // Preload gains are zero-sum with render-blocking bytes in flight pre-LCP;
  // without these guards H1 historically over-predicted savings by 10x on
  // bandwidth-constrained profiles (see the pets-site case E2E 2026-04-17: predicted
  // -2130ms, actual +203ms regression).
  const bwBytesPerMs = effectiveBandwidthBytesPerMs(ctx.profile);
  const rbBytes = renderBlockingBytesBeforeLcp(run);
  const rbTransferMs = isFinite(bwBytesPerMs) && bwBytesPerMs > 0
    ? Math.round(rbBytes / bwBytesPerMs)
    : 0;
  const heavyRenderBlocking = rbBytes >= HEAVY_RB_THRESHOLD_BYTES;

  // Build "used by render-blocking CSS" heuristic: fonts whose domain matches a
  // render-blocking CSS domain and whose startTime is after that CSS's start.
  const rbCssDomains = new Set(
    renderBlocking.filter((r) => r.type === 'css').map((r) => r.domain).filter(Boolean),
  );

  // Candidate: late-discovered img/font/script in preLCP.
  const candidates = preLCP.filter((r) => {
    if (!r || !r.url) return false;
    if (!['img', 'font', 'script'].includes(r.type)) return false;
    if (r.startTime <= LATE_DISCOVERY_MS) return false;
    // Only flag if either: matches LCP target URL, OR is a font used by render-blocking CSS.
    const isLcp = detectLcpTargetMatch(r, lcpAttr);
    const isFontUsedByRbCss = r.type === 'font' && rbCssDomains.has(r.domain);
    return isLcp || isFontUsedByRbCss;
  });

  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i];
    const isLcpImage = r.type === 'img' && detectLcpTargetMatch(r, lcpAttr);

    // Guard (a): if the LCP image starts at or before FCP, the HTML parser
    // already discovered it pre-paint — a preload adds no discovery benefit
    // and only competes for bandwidth with render-blocking resources. Emit
    // a rejected finding so the lifecycle is preserved and downstream
    // analyzers see the evaluation, but the orchestrator won't try it.
    if (isLcpImage && fcpValue !== null && r.startTime <= fcpValue) {
      const rejected = {
        schemaVersion: '1.0',
        id: `${ctx.shortName}-lcp-h1-${ctx.seq++}`,
        timestamp: isoNow(),
        url: ctx.url,
        skill: ctx.skill,
        source: ctx.source,
        metric: [LCP_METRIC],
        type: 'opportunity',
        severity: 'low',
        rootCause: false,
        cause: `LCP resource "${r.url}" starts at ${round(r.startTime)}ms, at or before FCP (${round(fcpValue)}ms) — already discovered by the HTML parser. Preload would be redundant and risk stealing bandwidth from render-blocking resources (the pets-site case 2026-04-17: +203ms regression on mobile-slow4g-4xcpu).`,
        evidence: [
          buildEvidenceLcpAttribution(run),
          buildEvidenceResourceTiming(r),
        ],
        recommendation: `Do not add a preload hint — the LCP resource is already discovered pre-FCP. Investigate elementRenderDelay (${round(lcpAttr.elementRenderDelay || 0)}ms) or resourceLoadDuration (${round(lcpAttr.resourceLoadDuration || 0)}ms) instead.`,
        confidence: capConfidence(ctx.source, 0.70),
        impactReduction: { metric: LCP_METRIC, valueMs: 0 },
        status: 'rejected',
      };
      if (validateFinding(rejected).valid) findings.push(rejected);
      continue;
    }

    // Guard (d): render-bound / JS-injected LCP image. When the LCP image is
    // discovered well after FCP AND that discovery is the majority of LCP, the
    // element is inserted by JS (framework render), not present in the initial
    // HTML — a <head> preload cannot advance the JS-gated insertion, so it saves
    // ~nothing and can regress LCP by preempting the render-critical JS. Emit a
    // rejected hypothesis (rootCause:false, no preload) that routes to the
    // unused-code / bundling fix path, mirroring Guard (a)'s lifecycle handling.
    if (
      isLcpImage
      && fcpValue !== null
      && r.startTime > fcpValue + RENDER_BOUND_DISCOVERY_MARGIN_MS
      && r.startTime >= RENDER_BOUND_LCP_FRACTION * lcp.value
    ) {
      const rejected = {
        schemaVersion: '1.0',
        id: `${ctx.shortName}-lcp-h1-${ctx.seq++}`,
        timestamp: isoNow(),
        url: ctx.url,
        skill: ctx.skill,
        source: ctx.source,
        metric: [LCP_METRIC],
        type: 'opportunity',
        severity: 'low',
        rootCause: false,
        cause: `LCP image "${r.url}" is discovered at ${round(r.startTime)}ms — ${round(r.startTime - fcpValue)}ms after FCP (${round(fcpValue)}ms) and ${Math.round((r.startTime / lcp.value) * 100)}% of the ${round(lcp.value)}ms LCP. An image in the initial HTML is found by the preload scanner near t≈0; this one is injected late by JS (framework render), so a <head> preload front-loads the bytes but cannot advance the JS-gated element insertion — LCP is render-bound, not load-bound (the petplace case 2026-07-23: preload drove resourceLoadDelay 13015→5ms yet LCP regressed +231ms).`,
        evidence: [
          buildEvidenceLcpAttribution(run),
          buildEvidenceResourceTiming(r),
        ],
        recommendation: `Do not add a preload hint — the LCP element is inserted by JS, so its paint is gated on script execution, not the network. Reduce the render-critical JS/CSS that delays the framework render (route to the unused-code / bundling playbooks) so the element mounts earlier.`,
        confidence: capConfidence(ctx.source, 0.70),
        impactReduction: { metric: LCP_METRIC, valueMs: 0 },
        status: 'rejected',
      };
      if (validateFinding(rejected).valid) findings.push(rejected);
      continue;
    }

    // Raw savings ceiling: we could shave up to (startTime - 100) if preloaded very early.
    let savedMs = Math.max(0, round(r.startTime - 100));

    // Guard (b): bandwidth-corrected cap. Preload cannot save more than the
    // observed resourceLoadDelay minus the transfer time of render-blocking
    // bytes that would compete for the same bandwidth window.
    const rld = round(lcpAttr.resourceLoadDelay || 0);
    let bwCapApplied = false;
    if (isLcpImage && rld > 0 && isFinite(rbTransferMs) && rbTransferMs > 0) {
      const bwCap = Math.max(0, rld - rbTransferMs);
      if (bwCap < savedMs) {
        savedMs = bwCap;
        bwCapApplied = true;
      }
    }

    // Physical cap: a preload can never pull LCP below FCP (the LCP element
    // cannot paint before first contentful paint), so savings ≤ (LCP − FCP).
    // Prevents any estimate that exceeds the achievable LCP improvement.
    if (fcpValue !== null) {
      savedMs = Math.min(savedMs, Math.max(0, round(lcp.value - fcpValue)));
    }

    // Guard (c): de-rate confidence when pre-LCP render-blocking payload is heavy.
    const baseConfidence = heavyRenderBlocking ? 0.55 : 0.75;
    const confidence = capConfidence(ctx.source, baseConfidence);

    const impactReduction = { metric: LCP_METRIC, valueMs: savedMs };
    const severity = deriveSeverity(impactReduction);
    const belowFloor = savedMs < MIN_IMPACT.LCP.delta;
    const status = belowFloor ? 'rejected' : 'proposed';

    const preloadPatch = { href: r.url, as: r.type === 'img' ? 'image' : r.type };
    if (r.type === 'img') preloadPatch.fetchpriority = 'high';
    if (r.type === 'font') preloadPatch.crossorigin = 'anonymous';

    let causeSuffix = '';
    if (heavyRenderBlocking || bwCapApplied) {
      const kb = Math.round(rbBytes / 1024);
      causeSuffix = ` Note: ${kb}KB of render-blocking resources compete pre-LCP (~${rbTransferMs}ms transfer on this profile); savings capped and confidence de-rated accordingly.`;
    }

    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-lcp-h1-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: ctx.source,
      metric: [LCP_METRIC],
      type: 'opportunity',
      severity,
      rootCause: true,
      cause: `Resource "${r.url}" started ${round(r.startTime)}ms into the page and finished before LCP (${round(lcp.value)}ms); a preload hint would shift its discovery left and reduce LCP resource-load-delay.${causeSuffix}`,
      evidence: [
        buildEvidenceLcpAttribution(run),
        buildEvidenceResourceTiming(r),
      ],
      recommendation: `Add <link rel="preload" as="${preloadPatch.as}" href="${r.url}"${r.type === 'img' ? ' fetchpriority="high"' : ''}${r.type === 'font' ? ' crossorigin' : ''}> in <head> above render-blocking CSS.`,
      patches: { preloads: [preloadPatch] },
      confidence,
      impactReduction,
      status,
    };

    if (validateFinding(finding).valid) findings.push(finding);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Heuristic 2: Shift-right (defer candidates)
// ---------------------------------------------------------------------------

function h2ShiftRight(run, ctx) {
  const findings = [];
  const renderBlocking = (run.resources && run.resources.renderBlocking) || [];
  const lcp = run.cwv && run.cwv.lcp ? run.cwv.lcp : null;
  if (!lcp || typeof lcp.value !== 'number') return findings;

  const candidates = renderBlocking.filter((r) => {
    if (!r || !r.url) return false;
    // Analytics/consent/chat/monitoring by domain, OR third-party low-priority blocker.
    if (isDeferrableDomain(r.domain)) return true;
    const isThirdParty = ctx.pageDomain && r.domain && r.domain !== ctx.pageDomain
      && !r.domain.endsWith('.' + ctx.pageDomain);
    const lowPriority = r.priority === 'Low' || r.priority === 'low' || r.priority === 'Medium' || r.priority === 'medium';
    return isThirdParty && lowPriority && r.type === 'script';
  });

  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i];
    // Conservative CPU saving: 10-30% of transferSize/1000 ms; use 20% midpoint.
    const savedMs = Math.max(0, round((r.transferSize || 0) * 0.20 / 1000));
    const impactReduction = { metric: LCP_METRIC, valueMs: savedMs };
    const severity = deriveSeverity(impactReduction);
    const belowFloor = savedMs < MIN_IMPACT.LCP.delta;
    const status = belowFloor ? 'rejected' : 'proposed';

    const patches = {};
    if (r.type === 'script') {
      patches.markup = [{ selector: `script[src*="${cssEscapeAttrValue(r.url)}"]`, attrs: { defer: '' } }];
      patches.block = [r.url]; // harness can also experiment with blocking as an A/B probe
    }

    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-lcp-h2-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: ctx.source,
      metric: [LCP_METRIC],
      type: 'waste',
      severity,
      rootCause: false,
      cause: `Render-blocking resource "${r.url}" is on the critical path but is deferrable (${isDeferrableDomain(r.domain) ? 'third-party in DEFERRABLE category' : 'low-priority third-party script'}); it pushes LCP right by occupying the preload scanner and main thread.`,
      evidence: [
        buildEvidenceLcpAttribution(run),
        buildEvidenceResourceTiming(r),
      ],
      recommendation: `Load "${r.url}" with async/defer or move it post-LCP (e.g. AEM EDS loadDelayed()). Do NOT preload or preconnect.`,
      patches,
      confidence: capConfidence(ctx.source, 0.75),
      impactReduction,
      status,
    };

    if (validateFinding(finding).valid) findings.push(finding);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Heuristic 3: Chain depth
// ---------------------------------------------------------------------------

/**
 * Find the longest same-origin sequential chain in preLCP where each next
 * request starts within a small gap after the previous one ends, and the next
 * request is initiator-type script (classic cascade).
 */
function longestChain(preLCP) {
  if (!preLCP || preLCP.length === 0) return [];
  // Sort by startTime ascending.
  const sorted = preLCP.slice().sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  // Greedy: for each resource, try to extend by finding a script request starting
  // within [endTime - 10, endTime + 150] ms on same origin.
  const chains = [];
  for (let i = 0; i < sorted.length; i++) {
    const chain = [sorted[i]];
    let tail = sorted[i];
    // scan forward
    for (let j = i + 1; j < sorted.length; j++) {
      const c = sorted[j];
      if (!c || !c.url) continue;
      if (c.initiatorType !== 'script' && c.type !== 'script') continue;
      const tailEnd = (tail.startTime || 0) + (tail.duration || 0);
      const gap = (c.startTime || 0) - tailEnd;
      if (gap >= -10 && gap <= 150 && sameOrigin(tail.url, c.url)) {
        chain.push(c);
        tail = c;
      }
    }
    if (chain.length > 1) chains.push(chain);
  }
  if (chains.length === 0) return [];
  chains.sort((a, b) => b.length - a.length);
  return chains[0];
}

function h3ChainDepth(run, ctx) {
  const findings = [];
  const preLCP = (run.resources && run.resources.preLCP) || [];
  const chain = longestChain(preLCP);
  if (chain.length < CHAIN_DEPTH_FLAG) return findings;

  const extraHops = chain.length - CHAIN_DEPTH_FLAG;
  const savedMs = (extraHops + 1) * RTT_MS_PER_HOP; // 1 hop saved per hop beyond 3rd; include the 3rd as baseline target
  const impactReduction = { metric: LCP_METRIC, valueMs: savedMs };
  const severity = deriveSeverity(impactReduction);
  const belowFloor = savedMs < MIN_IMPACT.LCP.delta;
  const status = belowFloor ? 'rejected' : 'proposed';

  const root = chain[0];
  const finding = {
    schemaVersion: '1.0',
    id: `${ctx.shortName}-lcp-h3-${ctx.seq++}`,
    timestamp: isoNow(),
    url: ctx.url,
    skill: ctx.skill,
    source: ctx.source,
    metric: [LCP_METRIC],
    type: 'bottleneck',
    severity,
    rootCause: true,
    cause: `Sequential request chain of depth ${chain.length} finishes before LCP starting at "${root.url}"; each serial hop adds ~${RTT_MS_PER_HOP}ms RTT on slow-4G.`,
    evidence: [
      buildEvidenceLcpAttribution(run),
      ...chain.slice(0, 6).map(buildEvidenceResourceTiming),
    ],
    recommendation: `Flatten the chain: preload every level, replace dynamic import() with static <script> tags, or bundle the cascade into a single request. Root initiator: ${root.url}.`,
    confidence: capConfidence(ctx.source, 0.70),
    impactReduction,
    status,
  };

  if (validateFinding(finding).valid) findings.push(finding);
  return findings;
}

// ---------------------------------------------------------------------------
// Heuristic 4: Main-thread pre-LCP blocking JS
// ---------------------------------------------------------------------------

function h4MainThreadBlockingJs(run, ctx) {
  const findings = [];
  const preLCP = (run.resources && run.resources.preLCP) || [];

  const candidates = preLCP.filter((r) => {
    if (!r || r.type !== 'script') return false;
    if ((r.transferSize || 0) < LARGE_JS_BYTES) return false;
    if (r.renderBlockingStatus === 'blocking') return false; // H2's job
    const high = r.priority === 'High' || r.priority === 'high' || r.priority === 'VeryHigh';
    return high;
  });

  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i];
    // CPU-ms approximation: ~1ms parse/compile per KB on mobile (slow-4G profile, 4x CPU).
    const savedMs = Math.max(0, round((r.transferSize || 0) / 1024));
    const impactReduction = { metric: LCP_METRIC, valueMs: savedMs };
    const severity = deriveSeverity(impactReduction);
    const belowFloor = savedMs < MIN_IMPACT.LCP.delta;
    const status = belowFloor ? 'rejected' : 'proposed';

    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-lcp-h4-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: ctx.source,
      metric: [LCP_METRIC, 'TBT'],
      type: 'bottleneck',
      severity,
      rootCause: false,
      cause: `Large high-priority script "${r.url}" (${round((r.transferSize || 0) / 1024)}KB) executed before LCP and likely blocked the main thread during LCP paint.`,
      evidence: [
        buildEvidenceLcpAttribution(run),
        buildEvidenceResourceTiming(r),
      ],
      recommendation: `Split "${r.url}" into critical + non-critical bundles, defer the non-critical portion past LCP, or lower its fetchpriority so it doesn't preempt the LCP paint.`,
      confidence: capConfidence(ctx.source, 0.65),
      impactReduction,
      status,
    };

    if (validateFinding(finding).valid) findings.push(finding);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Heuristic 5: LCP resource priority mismatch
// ---------------------------------------------------------------------------

function h5PriorityMismatch(run, ctx) {
  const findings = [];
  const preLCP = (run.resources && run.resources.preLCP) || [];
  const lcp = run.cwv && run.cwv.lcp ? run.cwv.lcp : null;
  if (!lcp || typeof lcp.value !== 'number') return findings;
  const lcpAttr = lcp.attribution || {};
  const target = lcpAttr.target || '';
  // Only fires when LCP is an image (heuristic: target selector contains "img" or attribution.url is image-like).
  const looksLikeImg = /img|picture/i.test(target) || (lcpAttr.url && /\.(png|jpg|jpeg|webp|avif|gif)(\?|$)/i.test(lcpAttr.url));
  if (!looksLikeImg) return findings;

  // Find the matching image resource.
  let imgResource = null;
  if (lcpAttr.url) {
    imgResource = preLCP.find((r) => r.url === lcpAttr.url) || null;
  }
  if (!imgResource) {
    // Fallback: the largest img in preLCP.
    const imgs = preLCP.filter((r) => r.type === 'img');
    imgs.sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0));
    imgResource = imgs[0] || null;
  }
  if (!imgResource) return findings;

  const prio = (imgResource.priority || '').toLowerCase();
  if (prio !== 'low' && prio !== 'medium') return findings;

  // Savings proxy: resourceLoadDelay attribution is the canonical number; fall back to startTime.
  const savedMs = Math.max(
    0,
    round(lcpAttr.resourceLoadDelay || Math.max(0, imgResource.startTime - 100)),
  );
  const impactReduction = { metric: LCP_METRIC, valueMs: savedMs };
  const severity = deriveSeverity(impactReduction);
  const belowFloor = savedMs < MIN_IMPACT.LCP.delta;
  const status = belowFloor ? 'rejected' : 'proposed';

  const finding = {
    schemaVersion: '1.0',
    id: `${ctx.shortName}-lcp-h5-${ctx.seq++}`,
    timestamp: isoNow(),
    url: ctx.url,
    skill: ctx.skill,
    source: ctx.source,
    metric: [LCP_METRIC],
    type: 'opportunity',
    severity,
    rootCause: true,
    cause: `LCP image "${imgResource.url}" was fetched at ${imgResource.priority} priority — the browser preload scanner did not recognize it as the LCP resource.`,
    evidence: [
      buildEvidenceLcpAttribution(run),
      buildEvidenceResourceTiming(imgResource),
    ],
    recommendation: `Add fetchpriority="high" to the LCP <img> tag (${target || 'selector not captured'}). Combine with rel=preload + fetchpriority=high for belt-and-braces.`,
    patches: {
      markup: [{ selector: target || `img[src="${cssEscapeAttrValue(imgResource.url)}"]`, attrs: { fetchpriority: 'high' } }],
      preloads: [{ href: imgResource.url, as: 'image', fetchpriority: 'high' }],
    },
    confidence: capConfidence(ctx.source, 0.80),
    impactReduction,
    status,
  };

  if (validateFinding(finding).valid) findings.push(finding);
  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze the launcher output and produce waterfall-shift findings.
 *
 * @param {object} launcherOutput - Parsed JSON output from launcher.js.
 * @param {object} [opts]
 * @param {string} [opts.skill="cwv-diagnose"] - Skill label to stamp on findings.
 * @param {string} [opts.source="perf_observer"] - Evidence source tier.
 * @param {number} [opts.runIndex=0] - Which run to analyze.
 * @returns {{ findings: object[], summary: string }}
 */
function analyzeWaterfall(launcherOutput, opts) {
  opts = opts || {};
  const skill = opts.skill || 'cwv-diagnose';
  const source = opts.source || 'perf_observer';
  const runIndex = typeof opts.runIndex === 'number' ? opts.runIndex : 0;

  if (!launcherOutput || !Array.isArray(launcherOutput.runs) || launcherOutput.runs.length === 0) {
    return { findings: [], summary: 'No runs in launcher output.' };
  }
  const run = launcherOutput.runs[runIndex];
  if (!run) {
    return { findings: [], summary: `No run at index ${runIndex}.` };
  }

  const ctx = {
    skill,
    source,
    url: launcherOutput.url || (run.cwv && run.cwv.url) || 'https://example.com/',
    shortName: skill.replace(/^cwv-/, ''),
    pageDomain: safeDomain(launcherOutput.url || ''),
    profile: launcherOutput.profile || opts.profile || null,
    seq: 1,
  };

  const findings = [];
  const addAll = (arr) => arr.forEach((f) => {
    const r = validateFinding(f);
    if (r.valid) findings.push(f);
    else process.stderr.write(`waterfall-shift: dropped invalid finding ${f.id}: ${r.errors.join('; ')}\n`);
  });

  addAll(h1ShiftLeft(run, ctx));
  addAll(h2ShiftRight(run, ctx));
  addAll(h3ChainDepth(run, ctx));
  addAll(h4MainThreadBlockingJs(run, ctx));
  addAll(h5PriorityMismatch(run, ctx));

  const active = findings.filter((f) => f.status !== 'rejected');
  const summary = [
    `waterfall-shift analyzed ${ctx.url} (LCP=${round((run.cwv && run.cwv.lcp && run.cwv.lcp.value) || 0)}ms)`,
    `emitted ${findings.length} finding(s), ${active.length} actionable`,
    `breakdown: ${['h1','h2','h3','h4','h5'].map((h) => `${h}=${findings.filter((f) => f.id.includes(`-${h}-`)).length}`).join(' ')}`,
  ].join(' — ');

  return { findings, summary };
}

export { analyzeWaterfall };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `
waterfall-shift — shift-left / preload-candidate analysis from a launcher measurement.

Usage: node waterfall-shift.js <launcher-output.json> [flags]

Args:
  <launcher-output.json>  Path to a launcher.js measurement JSON (required)

Flags:
  --output <path>         Write the finding envelope to a file (default: stdout)
  --help                  Print this help and exit 0
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  let file = null;
  let output = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output' || a === '-o') {
      output = argv[++i];
    } else if (a && a.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${a}\n` + HELP);
      process.exit(2);
    } else if (!file) {
      file = a;
    }
  }
  if (!file) {
    process.stderr.write('usage: node waterfall-shift.js <launcher-output.json> [--output <path>]\n');
    process.exit(2);
  }
  const abs = path.resolve(process.cwd(), file);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const out = analyzeWaterfall(data);
  // Emit a schema-valid finding envelope (finding-schema.js validateEnvelope),
  // matching coverage.js / html-parse.js so the diagnose flow can consume it directly.
  const envelope = {
    schemaVersion: '1.0',
    skill: 'cwv-diagnose',
    url: data.url || '',
    timestamp: new Date().toISOString(),
    summary: out.summary,
    findings: out.findings,
  };
  const json = JSON.stringify(envelope, null, 2);
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, json);
  } else {
    process.stdout.write(json + '\n');
  }
}
