#!/usr/bin/env node

/**
 * Chain-to-RUM correlator.
 *
 * Bridges field signal (Helix RUM Bundler) and lab evidence (launcher output
 * with resources + cwv attribution) so findings carry both "users feel it"
 * and "here is the cause" in a single artifact.
 *
 * Four correlation heuristics (see .agents/references/topics/chain-rum-correlation.md):
 *   C1  INP element  → deferrable-chain attribution
 *   C2  LCP element  → late/low-priority resource attribution
 *   C3  CLS element  → missing-dimensions image attribution
 *   C4  Field/lab disagreement meta-findings
 *
 * Usage:
 *   import { correlateChains } from './chain-rum-correlator.js';
 *   const out = correlateChains({ rumBundle, launcherOutput, htmlFindings });
 *
 * CLI:
 *   node chain-rum-correlator.js --rum <path> --launcher <path> [--html <path>] [--output <path>]
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
import { cssEscapeAttrValue } from '../selector-utils.js';
import { attributeFinding, normalizeFlavor } from '../attribution.js';

// ---------------------------------------------------------------------------
// Deferrable third-party domain patterns (subset mirrored from waterfall-shift;
// kept local so we don't cross-require a sibling analyzer).
// ---------------------------------------------------------------------------

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
  // Consent
  /(^|\.)onetrust\.com$/i,
  /(^|\.)cookielaw\.org$/i,
  /(^|\.)trustarc\.com$/i,
  /(^|\.)cookiebot\.com$/i,
  // Monitoring
  /(^|\.)sentry\.io$/i,
  /(^|\.)datadoghq\.com$/i,
  /(^|\.)newrelic\.com$/i,
  /(^|\.)nr-data\.net$/i,
  /(^|\.)rollbar\.com$/i,
  // Session replay
  /(^|\.)hotjar\.com$/i,
  /(^|\.)fullstory\.com$/i,
  /(^|\.)clarity\.ms$/i,
  /(^|\.)contentsquare\.net$/i,
  // A/B testing
  /(^|\.)optimizely\.com$/i,
  /(^|\.)launchdarkly\.com$/i,
  /(^|\.)split\.io$/i,
  // Chat
  /(^|\.)intercom\.io$/i,
  /(^|\.)drift\.com$/i,
  /(^|\.)zendesk\.com$/i,
  // Social pixels
  /(^|\.)facebook\.(com|net)$/i,
  /(^|\.)licdn\.com$/i,
];

function isDeferrableDomain(domain) {
  if (!domain) return false;
  return DEFERRABLE_DOMAIN_PATTERNS.some((re) => re.test(domain));
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const INP_FIELD_FLAG_MS = 200;     // match MIN_IMPACT.INP.poorAbove
const LCP_FIELD_FLAG_MS = 2500;
const CLS_ELEMENT_FLOOR = 0.05;    // per-element share
const INP_DEFER_SAVE_CAP_MS = 200;
const DISAGREEMENT_LOW_RATIO = 0.5;   // lab/field < 0.5 -> lab much better
const DISAGREEMENT_HIGH_RATIO = 1.5;  // lab/field > 1.5 -> lab much worse
const TEXT_SELECTOR_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'p', 'button', 'a']);
const SLOW_RESOURCE_TTFB_MS = MIN_IMPACT.TTFB.poorAbove;
const CDN_CACHE_MISS_TTFB_MS = MIN_IMPACT.TTFB.poorAbove;
const HTTP1_CRITICAL_IMPACT_MS = MIN_IMPACT.LCP.delta;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow() { return new Date().toISOString(); }

function round(n) {
  if (typeof n !== 'number' || !isFinite(n)) return 0;
  return Math.round(n);
}

function safeDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function capConfidence(source, desired) {
  const tier = SOURCE_TIERS[source];
  const cap = tier ? tier.maxConfidence : 0.5;
  return Math.min(desired, cap);
}

/**
 * Normalize a CSS selector fragment for loose comparison.
 * Handles "button.cta", "DIV#main>BUTTON.cta", "img.hero" etc.
 * Returns a lowercased tag+class-id token list, ignoring positional indexes.
 */
function normalizeSelector(sel) {
  if (!sel || typeof sel !== 'string') return '';
  // drop nth-child, attribute selectors, indexes
  const cleaned = sel
    .replace(/:nth-[^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase();
  // take last compound selector (the "leaf" element)
  const parts = cleaned.split(/\s|>/).filter(Boolean);
  const leaf = parts[parts.length - 1] || cleaned;
  return leaf;
}

function leafTag(sel) {
  const leaf = normalizeSelector(sel);
  const m = leaf.match(/^[a-z][\w-]*/);
  return m ? m[0] : '';
}

function normalizeFontFamily(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
}

function fontFamiliesFromStack(stack) {
  return String(stack || '')
    .split(',')
    .map(normalizeFontFamily)
    .filter(Boolean);
}

function fontDisplayIsSwapRisk(face) {
  const display = face && face.display ? String(face.display).trim().toLowerCase() : '';
  return display === '' || display === 'auto' || display === 'swap';
}

function fontStackForSelector(fonts, selector) {
  const used = fonts && fonts.usedFonts && typeof fonts.usedFonts === 'object'
    ? fonts.usedFonts : {};
  const tag = leafTag(selector);
  if (tag && Object.prototype.hasOwnProperty.call(used, tag)) return used[tag];
  if (tag && TEXT_SELECTOR_TAGS.has(tag) && Object.prototype.hasOwnProperty.call(used, 'body')) return used.body;
  return null;
}

function matchingSwapRiskFaces(fonts, selector) {
  if (!fonts || !Array.isArray(fonts.faces) || fonts.faces.length === 0) return [];
  const stack = fontStackForSelector(fonts, selector);
  if (!stack) return [];
  const families = new Set(fontFamiliesFromStack(stack));
  return fonts.faces.filter((face) => (
    face && fontDisplayIsSwapRisk(face) && families.has(normalizeFontFamily(face.family))
  ));
}

function fontFaceEvidence(face, selector, stack) {
  return {
    kind: 'font-face',
    data: {
      family: face.family || null,
      style: face.style || null,
      weight: face.weight || null,
      stretch: face.stretch || null,
      display: face.display || null,
      unicodeRange: face.unicodeRange || null,
      featureSettings: face.featureSettings || null,
      ascentOverride: face.ascentOverride || null,
      descentOverride: face.descentOverride || null,
      lineGapOverride: face.lineGapOverride || null,
      sizeAdjust: face.sizeAdjust || null,
      status: face.status || null,
      selector,
      computedFontFamily: stack || null,
      missingMetricOverrides: [
        !face.sizeAdjust ? 'sizeAdjust' : null,
        !face.ascentOverride ? 'ascentOverride' : null,
        !face.descentOverride ? 'descentOverride' : null,
        !face.lineGapOverride ? 'lineGapOverride' : null,
      ].filter(Boolean),
    },
  };
}

/**
 * Loose match: two selectors refer to the same element if their leaf tokens
 * share tag and at least one class/id, OR both are identical after normalize.
 */
function selectorsMatch(a, b) {
  const na = normalizeSelector(a);
  const nb = normalizeSelector(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Tokenize leaf like "button.cta.primary" into { tag: button, tokens: [.cta, .primary] }
  const tokA = na.match(/[.#][\w-]+|^[a-z][\w-]*/g) || [];
  const tokB = nb.match(/[.#][\w-]+|^[a-z][\w-]*/g) || [];
  if (tokA.length === 0 || tokB.length === 0) return false;
  const tagA = tokA[0].startsWith('.') || tokA[0].startsWith('#') ? null : tokA[0];
  const tagB = tokB[0].startsWith('.') || tokB[0].startsWith('#') ? null : tokB[0];
  if (tagA && tagB && tagA !== tagB) return false;
  const classesA = new Set(tokA.filter((t) => t.startsWith('.') || t.startsWith('#')));
  const classesB = new Set(tokB.filter((t) => t.startsWith('.') || t.startsWith('#')));
  for (const t of classesA) if (classesB.has(t)) return true;
  return false;
}

/**
 * Check whether a target selector is semantically equivalent to any entry in
 * a list of already-covered selectors. Uses selectorsMatch so that `tag#id`
 * (from lab `measure-cwv.js` event logs) matches `#id` (from RUM byElement)
 * and similar tag-vs-bare-class shape differences collapse correctly.
 *
 * Returns true if `target` is already covered; false otherwise. Callers
 * should push `target` onto `covered` when they decide to emit a new finding.
 */
function isSelectorCovered(covered, target) {
  if (!target) return false;
  for (const c of covered) if (selectorsMatch(c, target)) return true;
  return false;
}

/**
 * Sentinels produced by rum-fetch when element attribution is absent from
 * the RUM event (common for cwv-inp and cwv-cls in Helix instrumentation —
 * those events carry only {checkpoint, value, timeDelta} without a selector).
 */
function isUnknownTarget(sel) {
  if (!sel || typeof sel !== 'string') return true;
  const s = sel.trim().toLowerCase();
  return s === '' || s === 'unknown' || s === 'null' || s === 'undefined';
}

function selectorFromAttribution(attr) {
  if (!attr) return '';
  if (typeof attr === 'string') return attr;
  // web-vitals v4 attribution selector fields (all string CSS selectors):
  //   INP → interactionTarget
  //   CLS → largestShiftTarget
  //   LCP → element          (NOT "target" — that was an incorrect note in early plan docs)
  if (typeof attr.interactionTarget === 'string') return attr.interactionTarget;
  if (typeof attr.element === 'string') return attr.element;
  if (typeof attr.largestShiftTarget === 'string') return attr.largestShiftTarget;
  // Defensive fallback for any caller that passes a selector under `target`.
  if (typeof attr.target === 'string') return attr.target;
  // DOM-element plain copy produced by measure-cwv.plainAttribution
  if (attr.tagName) {
    const tag = String(attr.tagName).toLowerCase();
    const cls = typeof attr.className === 'string' && attr.className
      ? '.' + attr.className.trim().split(/\s+/).join('.')
      : '';
    const id = attr.id ? '#' + attr.id : '';
    return tag + id + cls;
  }
  return '';
}

function pickRun(launcherOutput, runIndex) {
  if (!launcherOutput || !Array.isArray(launcherOutput.runs)) return null;
  return launcherOutput.runs[runIndex] || null;
}

function buildEvidenceRumBundle(metric, p75, sampleCount, topSlow, dateRange) {
  const byElement = [];
  if (Array.isArray(topSlow)) {
    for (const s of topSlow.slice(0, 5)) {
      if (!s) continue;
      byElement.push({
        target: s.target || null,
        value: typeof s.value === 'number' ? s.value : null,
        url: s.url || null,
      });
    }
  }
  return {
    kind: 'rum-bundle',
    data: {
      metric,
      p75: round(p75),
      samples: sampleCount || 0,
      dateRange: dateRange || null,
      byElement,
    },
  };
}

function p75Number(values) {
  const nums = (Array.isArray(values) ? values : [])
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  return nums[Math.floor(nums.length * 0.75)] || 0;
}

function groupClsRumSamples(samples, labTarget) {
  const groups = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!sample) continue;
    const target = isUnknownTarget(sample.target) ? labTarget : sample.target;
    if (isUnknownTarget(target)) continue;
    const url = sample.url || '';
    const key = `${target}\n${url}\nCLS`;
    if (!groups.has(key)) {
      groups.set(key, {
        target,
        url,
        metric: 'CLS',
        samples: [],
        values: [],
      });
    }
    const group = groups.get(key);
    group.samples.push({ ...sample, target, url });
    if (typeof sample.value === 'number' && Number.isFinite(sample.value)) {
      group.values.push(sample.value);
    }
  }
  return Array.from(groups.values())
    .map((group) => {
      const sortedValues = group.values.slice().sort((a, b) => b - a);
      const examples = group.samples
        .slice()
        .sort((a, b) => (b.value || 0) - (a.value || 0))
        .slice(0, 5);
      return {
        target: group.target,
        url: group.url,
        metric: group.metric,
        count: group.samples.length,
        p75: p75Number(group.values),
        max: sortedValues[0] || 0,
        min: sortedValues[sortedValues.length - 1] || 0,
        values: sortedValues,
        examples,
      };
    })
    .sort((a, b) => {
      if (b.p75 !== a.p75) return b.p75 - a.p75;
      if (b.max !== a.max) return b.max - a.max;
      return b.count - a.count;
    });
}

function buildEvidenceResourceTiming(r) {
  return {
    kind: 'resource-timing',
    data: {
      url: r.url,
      startTime: round(r.startTime),
      transferSize: r.transferSize || 0,
      duration: round(r.duration),
      ttfb: typeof r.ttfb === 'number' ? round(r.ttfb) : null,
      renderBlockingStatus: r.renderBlockingStatus || null,
      priority: r.priority || null,
      type: r.type || null,
      nextHopProtocol: r.nextHopProtocol || null,
      serverTiming: Array.isArray(r.serverTiming) ? r.serverTiming : null,
    },
  };
}

function buildEvidenceCwvAttribution(metric, run) {
  const m = run && run.cwv && run.cwv[metric.toLowerCase()];
  const attr = (m && m.attribution) || {};
  const data = {
    valueMs: round((m && m.value) || 0),
    target: selectorFromAttribution(attr) || null,
  };
  // Copy a handful of useful attribution fields if present, verbatim.
  for (const k of [
    'url', 'resourceLoadDelay', 'elementRenderDelay', 'timeToFirstByte',
    'interactionTarget', 'interactionTime', 'inputDelay',
    'processingDuration', 'presentationDelay',
    'largestShiftValue', 'largestShiftTarget', 'loadState',
  ]) {
    if (attr[k] !== undefined) data[k] = typeof attr[k] === 'number' ? round(attr[k]) : attr[k];
  }
  return { kind: 'cwv-attribution', metric, data };
}

function sumTransferKb(resources) {
  let total = 0;
  for (const r of resources) total += (r.transferSize || 0) / 1024;
  return total;
}

function getByUrlEntry(rumBundle, pageUrl) {
  if (!rumBundle || !Array.isArray(rumBundle.byUrl)) return null;
  return rumBundle.byUrl.find((u) => u.url === pageUrl) || null;
}

function inpSamplesForUrl(rumBundle, pageUrl) {
  const top = (rumBundle && rumBundle.siteWide && rumBundle.siteWide.inp
    && rumBundle.siteWide.inp.topSlow) || [];
  return top.filter((s) => !pageUrl || s.url === pageUrl);
}

function lcpSamplesForUrl(rumBundle, pageUrl) {
  const top = (rumBundle && rumBundle.siteWide && rumBundle.siteWide.lcp
    && rumBundle.siteWide.lcp.topSlow) || [];
  return top.filter((s) => !pageUrl || s.url === pageUrl);
}

function clsSamplesForUrl(rumBundle, pageUrl) {
  const top = (rumBundle && rumBundle.siteWide && rumBundle.siteWide.cls
    && rumBundle.siteWide.cls.topSlow) || [];
  return top.filter((s) => !pageUrl || s.url === pageUrl);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Number.isFinite(aStart) && Number.isFinite(aEnd)
    && Number.isFinite(bStart) && Number.isFinite(bEnd)
    && aStart <= bEnd && bStart <= aEnd;
}

function interactionWindowsForTarget(run, target, labAttr) {
  const windows = [];
  const interactions = run && run.cwv && run.cwv.inp && Array.isArray(run.cwv.inp.interactions)
    ? run.cwv.inp.interactions : [];
  for (const it of interactions) {
    if (!it || !it.target || !selectorsMatch(it.target, target)) continue;
    const start = typeof it.startTime === 'number' ? it.startTime : null;
    const duration = typeof it.duration === 'number' ? it.duration : null;
    if (start != null && duration != null) {
      windows.push({
        start,
        end: start + duration,
        target: it.target,
        duration,
        name: it.name || null,
      });
    }
  }

  const interactionTime = labAttr && typeof labAttr.interactionTime === 'number'
    ? labAttr.interactionTime : null;
  const inpValue = run && run.cwv && run.cwv.inp && typeof run.cwv.inp.value === 'number'
    ? run.cwv.inp.value : null;
  if (interactionTime != null && inpValue != null) {
    windows.push({
      start: interactionTime,
      end: interactionTime + inpValue,
      target: selectorFromAttribution(labAttr) || target,
      duration: inpValue,
      name: null,
    });
  }

  return windows;
}

function loafScriptBlockingDuration(script, loaf) {
  if (!script || typeof script !== 'object') return 0;
  if (typeof script.blockingDuration === 'number') return Math.max(0, round(script.blockingDuration));
  if (typeof script.duration === 'number') return Math.max(0, round(script.duration));
  if (loaf && typeof loaf.blockingDuration === 'number') return Math.max(0, round(loaf.blockingDuration));
  return 0;
}

function findInpLoafAttribution(run, target, labAttr) {
  const loafs = run && run.cwv && run.cwv.mainThread && Array.isArray(run.cwv.mainThread.loaf)
    ? run.cwv.mainThread.loaf : [];
  if (loafs.length === 0) return null;

  const windows = interactionWindowsForTarget(run, target, labAttr);
  if (windows.length === 0) return null;

  const overlapping = [];
  for (const loaf of loafs) {
    if (!loaf || typeof loaf.startTime !== 'number') continue;
    const start = loaf.startTime;
    const duration = typeof loaf.duration === 'number' ? loaf.duration : 0;
    const end = start + duration;
    const window = windows.find((w) => rangesOverlap(w.start, w.end, start, end));
    if (!window) continue;
    overlapping.push({ loaf, window });
  }
  if (overlapping.length === 0) return null;

  const scriptMap = new Map();
  for (const item of overlapping) {
    const scripts = Array.isArray(item.loaf.scripts) ? item.loaf.scripts : [];
    for (const script of scripts) {
      if (!script || !script.sourceURL) continue;
      const key = `${script.sourceURL}\n${script.sourceFunctionName || ''}\n${script.invoker || ''}`;
      const blockingDuration = loafScriptBlockingDuration(script, item.loaf);
      const prev = scriptMap.get(key);
      const next = {
        sourceURL: script.sourceURL,
        sourceFunctionName: script.sourceFunctionName || null,
        invoker: script.invoker || null,
        invokerType: script.invokerType || null,
        duration: round(script.duration || 0),
        forcedStyleAndLayoutDuration: round(script.forcedStyleAndLayoutDuration || 0),
        pauseDuration: round(script.pauseDuration || 0),
        blockingDuration,
      };
      if (prev) {
        prev.duration += next.duration;
        prev.forcedStyleAndLayoutDuration += next.forcedStyleAndLayoutDuration;
        prev.pauseDuration += next.pauseDuration;
        prev.blockingDuration += next.blockingDuration;
      } else {
        scriptMap.set(key, next);
      }
    }
  }

  const topScripts = Array.from(scriptMap.values())
    .sort((a, b) => b.blockingDuration - a.blockingDuration)
    .slice(0, 5);
  if (topScripts.length === 0) return null;

  const topLoaf = overlapping
    .map((item) => item.loaf)
    .sort((a, b) => (b.blockingDuration || 0) - (a.blockingDuration || 0))[0];
  const topWindow = overlapping[0].window;
  return {
    target,
    interaction: topWindow,
    loafCount: overlapping.length,
    startTime: round(topLoaf.startTime || 0),
    duration: round(topLoaf.duration || 0),
    blockingDuration: round(topLoaf.blockingDuration || topScripts[0].blockingDuration || 0),
    renderStart: round(topLoaf.renderStart || 0),
    styleAndLayoutStart: round(topLoaf.styleAndLayoutStart || 0),
    topScripts,
  };
}

// ---------------------------------------------------------------------------
// C1: INP element → deferrable chain attribution
// ---------------------------------------------------------------------------

function c1InpChain(rumBundle, run, ctx) {
  const findings = [];
  const urlEntry = getByUrlEntry(rumBundle, ctx.url);
  const fieldP75 = urlEntry && typeof urlEntry.inp === 'number'
    ? urlEntry.inp
    : (rumBundle && rumBundle.siteWide && rumBundle.siteWide.inp
      && rumBundle.siteWide.inp.p75) || 0;
  if (fieldP75 < INP_FIELD_FLAG_MS) return findings;

  const inpSamples = inpSamplesForUrl(rumBundle, ctx.url);
  if (inpSamples.length === 0) return findings;

  // Group slow samples by target selector, keep the worst per target.
  const byTarget = new Map();
  for (const s of inpSamples) {
    if (isUnknownTarget(s.target)) continue;
    const prev = byTarget.get(s.target);
    if (!prev || (s.value || 0) > (prev.value || 0)) byTarget.set(s.target, s);
  }

  const sampleCount = (rumBundle && rumBundle.siteWide && rumBundle.siteWide.inp
    && rumBundle.siteWide.inp.sampleSize) || inpSamples.length;
  const dateRange = rumBundle && rumBundle.daysAnalyzed
    ? `${rumBundle.daysAnalyzed}d` : null;

  const labAttr = (run && run.cwv && run.cwv.inp && run.cwv.inp.attribution) || null;
  const labTarget = selectorFromAttribution(labAttr);

  const preLCP = (run && run.resources && run.resources.preLCP) || [];
  const postLCP = (run && run.resources && run.resources.postLCP) || [];
  const allJs = preLCP.concat(postLCP).filter((r) => r && r.type === 'script' && r.url);

  // Suspected chain: scripts on deferrable domains.
  const suspects = allJs.filter((r) => isDeferrableDomain(r.domain));

  for (const [target, sample] of byTarget) {
    const labMatches = labTarget && selectorsMatch(target, labTarget);
    const loafAttribution = labMatches ? findInpLoafAttribution(run, target, labAttr) : null;
    // We still emit when lab doesn't corroborate, but at lower confidence.
    const chainSuspects = suspects.slice(0, 6);
    const kb = sumTransferKb(chainSuspects);
    const savedMs = loafAttribution
      ? Math.max(0, round(loafAttribution.topScripts[0].blockingDuration || loafAttribution.blockingDuration || 0))
      : Math.min(INP_DEFER_SAVE_CAP_MS, Math.max(0, round(kb * 2)));

    const impactReduction = { metric: 'INP', valueMs: savedMs };
    const severity = deriveSeverity(impactReduction);
    const belowFloor = savedMs < MIN_IMPACT.INP.delta;
    const status = belowFloor ? 'rejected' : 'proposed';

    const evidence = [
      buildEvidenceRumBundle('INP', fieldP75, sampleCount, [sample], dateRange),
    ];
    if (labMatches) {
      evidence.push(buildEvidenceCwvAttribution('INP', run));
    }
    if (loafAttribution) {
      evidence.push({
        kind: 'long-animation-frame',
        metric: 'INP',
        data: loafAttribution,
      });
    } else {
      for (const r of chainSuspects) evidence.push(buildEvidenceResourceTiming(r));
    }

    const source = loafAttribution ? 'perf_observer' : 'rum';
    const confDesired = loafAttribution ? 0.85 : (labMatches ? 0.90 : 0.75);
    const confidence = Math.min(capConfidence(source, confDesired), 0.90);
    const topScriptUrls = loafAttribution
      ? loafAttribution.topScripts.map((s) => s.sourceURL).filter(Boolean)
      : [];
    const mergedSources = loafAttribution
      ? ['rum', 'perf_observer']
      : (labMatches ? ['rum', 'har'] : ['rum']);

    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-inp-c1-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source,
      metric: ['INP'],
      type: 'bottleneck',
      severity,
      rootCause: loafAttribution ? true : chainSuspects.length > 0,
      cause: loafAttribution
        ? `RUM p75 INP on "${target}" is ${round(sample.value)}ms (URL p75=${round(fieldP75)}ms, n=${sampleCount}); lab LoAF overlapped the interaction and names ${topScriptUrls.slice(0, 3).join(', ')} as the top blocking script${topScriptUrls.length === 1 ? '' : 's'} (${round(loafAttribution.topScripts[0].blockingDuration)}ms blocking).`
        : `RUM p75 INP on "${target}" is ${round(sample.value)}ms (URL p75=${round(fieldP75)}ms, n=${sampleCount})${chainSuspects.length ? `; lab waterfall shows ${chainSuspects.length} deferrable script(s) on the critical path (${chainSuspects.map((r) => r.domain).slice(0, 3).join(', ')}) plausibly competing for the main thread during interaction.` : '; no matching deferrable chain found in lab — investigate first-party interaction handlers.'}`,
      evidence,
      recommendation: loafAttribution
        ? `Profile and split the blocking interaction work in ${topScriptUrls.slice(0, 3).join(', ')}. Keep the "${target}" input path free of long synchronous tasks; yield non-urgent work with \`scheduler.yield()\` / \`setTimeout(..., 0)\` and defer analytics or hydration that does not need to run inside the handler.`
        : chainSuspects.length
          ? `Defer or async-load: ${chainSuspects.map((r) => r.url).slice(0, 3).join(', ')}. Move tag-manager / analytics bootstrap behind \`requestIdleCallback\` or post-interaction (AEM EDS \`loadDelayed()\`). Keep the click handler path free of synchronous third-party work.`
          : `Profile the click handler for "${target}" — RUM shows field INP is failing but lab did not capture the interaction. Re-run lab with \`launcher.js --interact "${target}"\` to reproduce.`,
      patches: !loafAttribution && chainSuspects.length ? {
        block: chainSuspects.map((r) => r.url),
        markup: chainSuspects.filter((r) => r.url).map((r) => ({
          selector: `script[src*="${cssEscapeAttrValue(r.url)}"]`,
          attrs: { defer: '' },
        })),
      } : undefined,
      confidence,
      impactReduction,
      status,
      mergedSources,
    };

    const v = validateFinding(finding);
    if (v.valid) findings.push(finding);
    else process.stderr.write(`chain-rum-correlator C1: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// C2: LCP element → late/low-priority resource attribution
// ---------------------------------------------------------------------------

function c2LcpResource(rumBundle, run, ctx) {
  const findings = [];
  const urlEntry = getByUrlEntry(rumBundle, ctx.url);
  const fieldP75 = urlEntry && typeof urlEntry.lcp === 'number'
    ? urlEntry.lcp
    : (rumBundle && rumBundle.siteWide && rumBundle.siteWide.lcp
      && rumBundle.siteWide.lcp.p75) || 0;
  if (fieldP75 < LCP_FIELD_FLAG_MS) return findings;

  const lcpSamples = lcpSamplesForUrl(rumBundle, ctx.url);
  if (lcpSamples.length === 0) return findings;

  const labLcp = run && run.cwv && run.cwv.lcp;
  const labAttr = (labLcp && labLcp.attribution) || null;
  const labTarget = selectorFromAttribution(labAttr);
  const labResourceUrl = labAttr && labAttr.url;
  const preLCP = (run && run.resources && run.resources.preLCP) || [];

  // Prefer the worst RUM sample that matches the lab target.
  let rumSample = null;
  for (const s of lcpSamples) {
    if (s.target && selectorsMatch(s.target, labTarget)) {
      if (!rumSample || (s.value || 0) > (rumSample.value || 0)) rumSample = s;
    }
  }
  if (!rumSample) rumSample = lcpSamples[0];

  // Correlate with the lab-observed LCP resource.
  let labResource = null;
  if (labResourceUrl) labResource = preLCP.find((r) => r.url === labResourceUrl) || null;
  if (!labResource) {
    // Fallback: largest image pre-LCP.
    const imgs = preLCP.filter((r) => r.type === 'img');
    imgs.sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0));
    labResource = imgs[0] || null;
  }
  if (!labResource) return findings;

  // The lab finding is relevant only when the resource is suspicious.
  const prio = (labResource.priority || '').toLowerCase();
  const lowPriority = prio === 'low' || prio === 'medium';
  const nonBlocking = labResource.renderBlockingStatus === 'non-blocking';
  const lateStart = (labLcp && typeof labLcp.value === 'number')
    ? labResource.startTime > labLcp.value * 0.5 : false;
  if (!lowPriority && !lateStart && !nonBlocking) return findings;

  const sampleCount = (rumBundle && rumBundle.siteWide && rumBundle.siteWide.lcp
    && rumBundle.siteWide.lcp.sampleSize) || lcpSamples.length;
  const dateRange = rumBundle && rumBundle.daysAnalyzed
    ? `${rumBundle.daysAnalyzed}d` : null;

  const resourceLoadDelay = (labAttr && typeof labAttr.resourceLoadDelay === 'number')
    ? labAttr.resourceLoadDelay : Math.max(0, labResource.startTime - 100);
  const savedMs = Math.max(0, round(resourceLoadDelay));
  const impactReduction = { metric: 'LCP', valueMs: savedMs };
  const severity = deriveSeverity(impactReduction);
  const belowFloor = savedMs < MIN_IMPACT.LCP.delta;
  const status = belowFloor ? 'rejected' : 'proposed';

  const evidence = [
    buildEvidenceRumBundle('LCP', fieldP75, sampleCount, [rumSample], dateRange),
    buildEvidenceCwvAttribution('LCP', run),
    buildEvidenceResourceTiming(labResource),
  ];

  const confidence = Math.min(capConfidence('rum', 0.90), 0.90);

  const selectorForMarkup = labTarget || (rumSample && rumSample.target) || `img[src="${cssEscapeAttrValue(labResource.url)}"]`;
  const finding = {
    schemaVersion: '1.0',
    id: `${ctx.shortName}-lcp-c2-${ctx.seq++}`,
    timestamp: isoNow(),
    url: ctx.url,
    skill: ctx.skill,
    source: 'rum',
    metric: ['LCP'],
    type: 'bottleneck',
    severity,
    rootCause: true,
    cause: `RUM p75 LCP is ${round(fieldP75)}ms on this URL (n=${sampleCount}); lab LCP element "${labTarget || rumSample.target || 'unknown'}" is served by "${labResource.url}" at ${labResource.priority || 'unknown'} priority, discovered at ${round(labResource.startTime)}ms (resourceLoadDelay=${round(resourceLoadDelay)}ms). Field confirms the lab discovery gap matters.`,
    evidence,
    recommendation: `Add \`fetchpriority="high"\` to the LCP <img>, and a \`<link rel=preload as=image href="${labResource.url}" fetchpriority="high">\` in \`<head>\` above render-blocking CSS.`,
    patches: {
      markup: [
        { selector: selectorForMarkup, attrs: { fetchpriority: 'high' } },
      ],
      preloads: [
        { href: labResource.url, as: labResource.type === 'img' ? 'image' : (labResource.type || 'image'), fetchpriority: 'high' },
      ],
    },
    confidence,
    impactReduction,
    status,
    mergedSources: ['rum', 'har'],
  };

  const v = validateFinding(finding);
  if (v.valid) findings.push(finding);
  else process.stderr.write(`chain-rum-correlator C2: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
  return findings;
}

// ---------------------------------------------------------------------------
// C3: CLS element → missing-dimensions image attribution
// ---------------------------------------------------------------------------

function c3ClsImage(rumBundle, run, ctx, htmlFindings) {
  const findings = [];
  const urlEntry = getByUrlEntry(rumBundle, ctx.url);
  const fieldP75 = urlEntry && typeof urlEntry.cls === 'number'
    ? urlEntry.cls
    : (rumBundle && rumBundle.siteWide && rumBundle.siteWide.cls
      && rumBundle.siteWide.cls.p75) || 0;

  const clsSamples = clsSamplesForUrl(rumBundle, ctx.url).filter((s) => (s.value || 0) >= CLS_ELEMENT_FLOOR);
  if (clsSamples.length === 0 && fieldP75 < 0.1) return findings;

  const labAttr = (run && run.cwv && run.cwv.cls && run.cwv.cls.attribution) || null;
  const labTarget = selectorFromAttribution(labAttr);
  const loadState = labAttr && labAttr.loadState;

  const imgs = (run && run.resources && run.resources.byType && run.resources.byType.img) || [];

  // Find image resources that plausibly lack dimensions: we use htmlFindings
  // if supplied (rule firings for missing width/height), else fall back to
  // "any image pre-LCP without an exact lab selector match".
  const missingDimUrls = new Set();
  if (Array.isArray(htmlFindings)) {
    for (const hf of htmlFindings) {
      if (!hf || !Array.isArray(hf.evidence)) continue;
      for (const ev of hf.evidence) {
        if (ev && ev.kind === 'rule-violation' && ev.data
          && /dimension|width|height/i.test(String(ev.data.ruleId || ''))) {
          const url = ev.data.match && ev.data.match.url;
          if (url) missingDimUrls.add(url);
        }
      }
    }
  }

  const sampleCount = (rumBundle && rumBundle.siteWide && rumBundle.siteWide.cls
    && rumBundle.siteWide.cls.sampleSize) || clsSamples.length || 1;
  const dateRange = rumBundle && rumBundle.daysAnalyzed
    ? `${rumBundle.daysAnalyzed}d` : null;

  // Build one correlated finding per selector+URL group, not per repeated RUM
  // slow sample. Preserve the distribution in evidence so the field signal is
  // still inspectable without spamming duplicate findings.
  const rumSamples = clsSamples.length ? clsSamples : (labTarget ? [{ target: labTarget, value: fieldP75 }] : []);
  const rumGroups = groupClsRumSamples(rumSamples, labTarget);
  for (const rumGroup of rumGroups.slice(0, 5)) {
    const targetSel = rumGroup.target;

    // Match to an image resource by selector hint (tag/class) when the target
    // looks like an <img>, else fall back to any suspicious image.
    let culprit = null;
    if (/img|picture/i.test(targetSel)) {
      culprit = imgs.find((r) => missingDimUrls.has(r.url))
        || imgs.find((r) => labAttr && labAttr.url && r.url === labAttr.url)
        || imgs[0] || null;
    }

    const shift = Math.max(0, rumGroup.p75 || rumGroup.max || 0);
    const valuesAsc = rumGroup.values.slice().sort((a, b) => a - b);
    const minShift = valuesAsc.length ? valuesAsc[0] : shift;
    const maxShift = valuesAsc.length ? valuesAsc[valuesAsc.length - 1] : shift;
    const impactReduction = { metric: 'CLS', score: Number(shift.toFixed(3)) };
    const severity = deriveSeverity(impactReduction);
    const belowFloor = Math.abs(shift) < MIN_IMPACT.CLS.delta;
    const status = belowFloor ? 'rejected' : 'proposed';

    const evidence = [
      buildEvidenceRumBundle('CLS', fieldP75, sampleCount, rumGroup.examples, dateRange),
    ];
    evidence[0].data.sampleAggregation = {
      selector: targetSel,
      count: rumGroup.count,
      min: Number(minShift.toFixed(4)),
      max: Number(maxShift.toFixed(4)),
      values: valuesAsc.map((v) => Number(v.toFixed(4))),
    };
    evidence[0].data.valueDistribution = {
      metric: rumGroup.metric,
      target: rumGroup.target,
      url: rumGroup.url || null,
      sampleCount: rumGroup.count,
      p75: Number(rumGroup.p75.toFixed(4)),
      max: Number(rumGroup.max.toFixed(4)),
      min: Number(rumGroup.min.toFixed(4)),
      values: rumGroup.values.slice(0, 10),
    };
    if (labAttr) evidence.push(buildEvidenceCwvAttribution('CLS', run));
    if (culprit) evidence.push(buildEvidenceResourceTiming(culprit));

    const merged = ['rum'];
    if (labAttr) merged.push('har');
    if (missingDimUrls.size > 0) merged.push('html');

    const confidence = Math.min(capConfidence('rum', culprit ? 0.85 : 0.70), 0.90);

    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-cls-c3-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: 'rum',
      metric: ['CLS'],
      type: 'opportunity',
      severity,
      rootCause: Boolean(culprit),
      cause: `RUM shows ${rumGroup.count} layout-shift sample(s) for "${targetSel}" on ${rumGroup.url || ctx.url} (p75=${shift.toFixed(3)}, max=${rumGroup.max.toFixed(3)})${loadState ? `, loadState=${loadState}` : ''}${culprit ? `; lab resource "${culprit.url}" is an image likely missing width/height attributes` : ''}.`,
      evidence,
      recommendation: culprit
        ? `Add explicit \`width\` and \`height\` attributes (or \`aspect-ratio\` CSS) to the image element "${targetSel}" / "${culprit.url}". Reserve space before the image loads.`
        : `Investigate layout shift contributor "${targetSel}" — likely a late-loading image, web font swap, or injected banner. Ensure space is reserved before the element renders.`,
      patches: culprit ? {
        markup: [{ selector: targetSel, attrs: { loading: 'eager' } }],
      } : undefined,
      confidence,
      impactReduction,
      status,
      mergedSources: merged,
    };

    const v = validateFinding(finding);
    if (v.valid) findings.push(finding);
    else process.stderr.write(`chain-rum-correlator C3: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// C4: Field/lab disagreement meta-findings
// ---------------------------------------------------------------------------

function c4Disagreement(rumBundle, run, ctx) {
  const findings = [];
  const urlEntry = getByUrlEntry(rumBundle, ctx.url);

  for (const metric of ['LCP', 'INP', 'CLS']) {
    const key = metric.toLowerCase();
    const rumP75 = urlEntry && typeof urlEntry[key] === 'number'
      ? urlEntry[key]
      : (rumBundle && rumBundle.siteWide && rumBundle.siteWide[key]
        && rumBundle.siteWide[key].p75) || 0;
    if (!rumP75) continue;
    const labValue = run && run.cwv && run.cwv[key] && typeof run.cwv[key].value === 'number'
      ? run.cwv[key].value : null;
    if (labValue == null) continue;
    // CLS can legitimately be 0 in lab — don't treat as "no data" the way we do for LCP/INP.
    if (metric !== 'CLS' && labValue === 0) continue;
    // Guard against divide-by-zero for CLS when rumP75 is tiny.
    const ratio = rumP75 > 0 ? labValue / rumP75 : null;
    if (ratio == null) continue;

    let cause = null;
    let recommendation = null;
    let severityDesired = 'low';

    const unit = metric === 'CLS' ? '' : 'ms';
    const fmt = (v) => (metric === 'CLS' ? v.toFixed(3) : String(round(v)));

    if (ratio < DISAGREEMENT_LOW_RATIO) {
      cause = `Lab ${metric} (${fmt(labValue)}${unit}) is far better than RUM p75 (${fmt(rumP75)}${unit}) — ratio ${ratio.toFixed(2)}. Lab is not reproducing the field condition (likely personalization, auth state, geo, A/B variant, consent-banner timing, or weak throttling profile).`;
      recommendation = `Re-run the lab with conditions closer to the median real user: authenticated cookie, viewport/device profile from RUM \`byInteractionType\`, geo-proxy if CDN varies, and do NOT pre-accept the consent banner (it often triggers the largest shift). Do not trust lab-only fixes until the lab reproduces a ${metric} within 30% of field p75.`;
      severityDesired = 'low';
    } else if (ratio > DISAGREEMENT_HIGH_RATIO) {
      cause = `Lab ${metric} (${fmt(labValue)}${unit}) is far worse than RUM p75 (${fmt(rumP75)}${unit}) — ratio ${ratio.toFixed(2)}. Lab throttling profile may be too aggressive, or real users have better devices/networks than \`mobile-slow4g-4xcpu\`.`;
      recommendation = `Sanity-check the lab throttling profile against the RUM device mix. Consider \`desktop-cable-1xcpu\` if the RUM traffic is predominantly desktop. Trust field when in doubt.`;
      severityDesired = 'low';
    } else {
      continue;
    }

    const sampleCount = (rumBundle && rumBundle.siteWide && rumBundle.siteWide[key]
      && rumBundle.siteWide[key].sampleSize) || 0;
    const dateRange = rumBundle && rumBundle.daysAnalyzed
      ? `${rumBundle.daysAnalyzed}d` : null;

    const evidence = [
      buildEvidenceRumBundle(metric, rumP75, sampleCount, [], dateRange),
      buildEvidenceCwvAttribution(metric, run),
    ];

    const impactReduction = metric === 'CLS'
      ? { metric, score: 0 }
      : { metric, valueMs: 0 };

    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-${key}-c4-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: 'rum',
      metric: [metric],
      type: 'opportunity',
      severity: severityDesired,
      rootCause: false,
      cause,
      evidence,
      recommendation,
      confidence: Math.min(capConfidence('rum', 0.80), 0.90),
      impactReduction,
      status: 'draft',
      mergedSources: ['rum', 'har'],
    };

    const v = validateFinding(finding);
    if (v.valid) findings.push(finding);
    else process.stderr.write(`chain-rum-correlator C4: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// C7: Font-face descriptors → text-LCP / font-CLS attribution
// ---------------------------------------------------------------------------

function c7FontFaces(run, ctx, existingFindings) {
  const findings = [];
  const fonts = run && run.fonts;
  if (!fonts || !Array.isArray(fonts.faces) || fonts.faces.length === 0 || !fonts.swapRisk) return findings;

  const covered = [];
  for (const f of existingFindings || []) {
    if (!Array.isArray(f.metric)) continue;
    for (const ev of f.evidence || []) {
      if (ev && ev.data && typeof ev.data.target === 'string') covered.push(ev.data.target);
    }
  }

  const recommendation = (family) => (
    `Tune the fallback metrics for "${family}": add a local fallback \`@font-face\` with ` +
    '`size-adjust`, `ascent-override`, `descent-override`, and `line-gap-override`, then put it ' +
    'immediately after the brand face in the `font-family` stack. This reserves nearly the same text box ' +
    'before the web font swaps in; pair with a narrow preload only when the face is truly on the LCP path.'
  );

  const labLcp = run && run.cwv && run.cwv.lcp;
  const lcpAttr = (labLcp && labLcp.attribution) || null;
  const lcpTarget = selectorFromAttribution(lcpAttr);
  const lcpTag = leafTag(lcpTarget);
  const lcpDelay = lcpAttr && typeof lcpAttr.elementRenderDelay === 'number'
    ? lcpAttr.elementRenderDelay : 0;
  const lcpValue = labLcp && typeof labLcp.value === 'number' ? labLcp.value : 0;
  const lcpFaces = TEXT_SELECTOR_TAGS.has(lcpTag) ? matchingSwapRiskFaces(fonts, lcpTarget) : [];
  if (lcpFaces.length > 0 && (lcpValue >= MIN_IMPACT.LCP.poorAbove || lcpDelay >= MIN_IMPACT.LCP.delta)) {
    const face = lcpFaces[0];
    const stack = fontStackForSelector(fonts, lcpTarget);
    const savedMs = Math.max(MIN_IMPACT.LCP.delta, round(lcpDelay || Math.min(lcpValue, 400)));
    const impactReduction = { metric: 'LCP', valueMs: savedMs };
    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-font-c7-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: 'perf_observer',
      metric: ['LCP'],
      type: 'bottleneck',
      severity: deriveSeverity(impactReduction),
      rootCause: true,
      cause: `Lab LCP element "${lcpTarget}" is text using swap-risk font "${face.family}" (font-display=${face.display || 'unset'}, computed stack="${stack || 'unknown'}") with elementRenderDelay=${round(lcpDelay)}ms.`,
      evidence: [
        buildEvidenceCwvAttribution('LCP', run),
        fontFaceEvidence(face, lcpTarget, stack),
      ],
      recommendation: recommendation(face.family || 'the web font'),
      confidence: capConfidence('perf_observer', 0.80),
      impactReduction,
      status: 'proposed',
      mergedSources: ['perf_observer'],
    };
    const v = validateFinding(finding);
    if (v.valid) {
      findings.push(finding);
      covered.push(lcpTarget);
    } else {
      process.stderr.write(`chain-rum-correlator C7: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
    }
  }

  const shifts = run && run.cwv && run.cwv.cls && Array.isArray(run.cwv.cls.shifts)
    ? run.cwv.cls.shifts : [];
  const significant = shifts
    .filter((s) => s && !s.hadRecentInput && typeof s.value === 'number'
      && s.value >= MIN_IMPACT.CLS.delta)
    .slice()
    .sort((a, b) => b.value - a.value);

  for (const shift of significant) {
    const sources = Array.isArray(shift.sources) ? shift.sources : [];
    let matched = null;
    for (const source of sources) {
      const target = source && source.target;
      if (!target || isSelectorCovered(covered, target)) continue;
      if (!TEXT_SELECTOR_TAGS.has(leafTag(target))) continue;
      const faces = matchingSwapRiskFaces(fonts, target);
      if (faces.length === 0) continue;
      matched = { source, face: faces[0], stack: fontStackForSelector(fonts, target) };
      break;
    }
    if (!matched) continue;

    const target = matched.source.target;
    const impactReduction = { metric: 'CLS', score: Number(shift.value.toFixed(3)) };
    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-font-c7-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: 'perf_observer',
      metric: ['CLS'],
      type: 'opportunity',
      severity: deriveSeverity(impactReduction),
      rootCause: true,
      cause: `Lab observed a ${shift.value.toFixed(3)} layout shift from text source "${target}" using swap-risk font "${matched.face.family}" (font-display=${matched.face.display || 'unset'}, computed stack="${matched.stack || 'unknown'}").`,
      evidence: [
        {
          kind: 'cwv-attribution',
          metric: 'CLS',
          data: {
            score: Number(shift.value.toFixed(4)),
            startTime: shift.startTime || 0,
            target,
            previousRect: matched.source.previousRect || null,
            currentRect: matched.source.currentRect || null,
          },
        },
        fontFaceEvidence(matched.face, target, matched.stack),
      ],
      recommendation: recommendation(matched.face.family || 'the web font'),
      confidence: capConfidence('perf_observer', 0.80),
      impactReduction,
      status: 'proposed',
      mergedSources: ['perf_observer'],
    };
    const v = validateFinding(finding);
    if (v.valid) {
      findings.push(finding);
      covered.push(target);
    } else {
      process.stderr.write(`chain-rum-correlator C7: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
    }
    break;
  }

  return findings;
}

// ---------------------------------------------------------------------------
// C5: Lab-captured INP interactions (from measure-cwv.js event log)
// ---------------------------------------------------------------------------
// Walks `run.cwv.inp.interactions` and emits one finding per slow interaction
// (duration ≥ MIN_IMPACT.INP.delta). These complement C1 by surfacing
// interactions that field RUM cannot attribute (Helix cwv-inp events carry no
// target). Source tier is `perf_observer` (cap 0.85).

function c5LabInpInteractions(run, ctx, existingFindings) {
  const findings = [];
  const interactions = run && run.cwv && run.cwv.inp && Array.isArray(run.cwv.inp.interactions)
    ? run.cwv.inp.interactions : [];
  if (interactions.length === 0) return findings;

  // Targets already covered by C1 — skip them to avoid duplicate findings.
  // Uses selectorsMatch for semantic equivalence (e.g. lab `button#cta` ≡ RUM `#cta`).
  const covered = [];
  for (const f of existingFindings) {
    if (!Array.isArray(f.metric) || !f.metric.includes('INP')) continue;
    for (const ev of f.evidence || []) {
      if (!ev || !ev.data) continue;
      if (Array.isArray(ev.data.byElement)) {
        for (const b of ev.data.byElement) if (b && b.target) covered.push(b.target);
      }
      if (typeof ev.data.target === 'string') covered.push(ev.data.target);
    }
  }

  const slow = interactions
    .filter((i) => i && typeof i.duration === 'number' && i.duration >= MIN_IMPACT.INP.delta)
    .slice()
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5);

  for (const it of slow) {
    if (!it.target) continue;
    if (isSelectorCovered(covered, it.target)) continue;
    covered.push(it.target);

    const inputDelay = Math.max(0, (it.processingStart || 0) - (it.startTime || 0));
    const processingDuration = Math.max(0, (it.processingEnd || 0) - (it.processingStart || 0));
    const presentationDelay = Math.max(0, it.duration - (inputDelay + processingDuration));
    let phase = 'processing';
    if (inputDelay >= processingDuration && inputDelay >= presentationDelay) phase = 'input-delay';
    else if (presentationDelay > processingDuration) phase = 'presentation';

    const impactReduction = { metric: 'INP', valueMs: round(it.duration) };
    const severity = deriveSeverity(impactReduction);

    const recommendation = phase === 'input-delay'
      ? `Interaction was blocked by main-thread work before the handler ran (inputDelay=${round(inputDelay)}ms). Defer or async-load scripts that execute before user input is possible; move tag-manager/analytics bootstrap behind \`requestIdleCallback\` or post-LCP.`
      : phase === 'processing'
        ? `Event handler for "${it.target}" took ${round(processingDuration)}ms. Profile it and break up long synchronous work with \`scheduler.yield()\` or \`setTimeout(..., 0)\`. For AEM EDS, use \`yieldUnlessUrgent()\` in block decorators.`
        : `Large DOM update after the handler (presentationDelay=${round(presentationDelay)}ms). Reduce DOM size in the interaction region, apply CSS \`contain: layout\`, or batch mutations inside \`requestAnimationFrame\`.`;

    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-inp-c5-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: 'perf_observer',
      metric: ['INP'],
      type: 'bottleneck',
      severity,
      rootCause: false,
      cause: `Lab captured a ${round(it.duration)}ms ${it.name} interaction on "${it.target}" — input delay=${round(inputDelay)}ms, processing=${round(processingDuration)}ms, presentation=${round(presentationDelay)}ms. Dominant phase: ${phase}.`,
      evidence: [
        {
          kind: 'cwv-attribution',
          metric: 'INP',
          data: {
            valueMs: round(it.duration),
            target: it.target,
            interactionId: it.interactionId,
            name: it.name,
            inputDelay: round(inputDelay),
            processingDuration: round(processingDuration),
            presentationDelay: round(presentationDelay),
            entryCount: it.entryCount,
          },
        },
      ],
      recommendation,
      confidence: capConfidence('perf_observer', 0.80),
      impactReduction,
      status: 'proposed',
      mergedSources: ['perf_observer'],
    };

    const v = validateFinding(finding);
    if (v.valid) findings.push(finding);
    else process.stderr.write(`chain-rum-correlator C5: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// C6: Lab-captured CLS shifts (from measure-cwv.js event log)
// ---------------------------------------------------------------------------
// Walks `run.cwv.cls.shifts` and emits one finding per high-impact shift
// (value ≥ MIN_IMPACT.CLS.delta, !hadRecentInput). Complements C3 by surfacing
// non-largest shifts that still individually exceed the reporting floor.
//
// Attribution model:
//   The browser's LayoutShift.sources[] includes BOTH the element that grew
//   and the elements that were pushed by that growth (the victims). The
//   element that *grew* is the cause — reserving space on a victim is a no-op.
//   Classify each source by comparing previousRect vs currentRect:
//     - grew  : currentRect.height > previousRect.height + SUBPIXEL_EPSILON
//     - moved : |yDelta| > 0 and heightDelta ≈ 0
//   Prefer the earliest grown source (smallest previousRect.y) as the
//   attribution target. If nothing grew (pure repositioning), fall back to
//   the widest-rect moved source and flag `shiftWithoutGrowth` so the reader
//   knows this isn't the typical injection-shift pattern.

const SHIFT_SUBPIXEL_EPSILON = 1; // ignore sub-pixel noise in rect deltas

function classifyShiftSource(src) {
  const prev = src.previousRect || { x: 0, y: 0, width: 0, height: 0 };
  const cur = src.currentRect || { x: 0, y: 0, width: 0, height: 0 };
  const heightDelta = (cur.height || 0) - (prev.height || 0);
  const yDelta = (cur.y || 0) - (prev.y || 0);
  const grew = heightDelta > SHIFT_SUBPIXEL_EPSILON;
  const moved = !grew && Math.abs(yDelta) > SHIFT_SUBPIXEL_EPSILON
    && Math.abs(heightDelta) <= SHIFT_SUBPIXEL_EPSILON;
  return { heightDelta, yDelta, grew, moved, prev, cur };
}

// V5 — "animated-reveal" CLS mechanism classifier.
// ---------------------------------------------------------------------------
// The consent banner (jQuery `.show(duration)` tweening width/height) and the
// tabbed editorial module (`display:none → flex` reveal) are the SAME anti-pattern:
// a box whose layout-affecting size is animated/revealed across several frames,
// shifting everything below it. The fix is identical — render at final size and
// animate only `transform`/`opacity` — so detecting the mechanism lets cwv-fix
// propose the right thing instead of a generic "reserve space".
//
// The distinctive, low-false-positive signal is a target that appears across
// MULTIPLE consecutive layout-shift frames with:
//   - monotonic-growth   : currentRect width AND height non-decreasing each frame,
//                          with meaningful net growth in both (a tween); or
//   - appears-from-zero   : the first frame's previousRect is ~0×0 in BOTH dims
//                          (revealed from `display:none`), present across ≥2 frames.
// A SINGLE one-time grow-from-0 is deliberately NOT flagged — that's the generic
// unsized-element/late-injection case the existing C6 "reserve space" advice
// already covers, and flagging it would mislabel ordinary CLS.
//
// Data is already captured in `cls.shifts[].sources[]` (previousRect/currentRect/
// startTime per source) — no injector change. Pure; exported for reuse + tests.

const REVEAL_MIN_GROWTH_STEPS = 3; // frames of monotonic growth ⇒ a tween, not a one-off
const REVEAL_MIN_APPEAR_STEPS = 2; // frames for an appears-from-display:none reveal
const REVEAL_MIN_GROWTH_PX = 8; // net growth (each dim) to clear sub-pixel noise

function rectWH(r) {
  return { w: (r && r.width) || 0, h: (r && r.height) || 0 };
}

function detectAnimatedReveals(shifts) {
  const reveals = new Map();
  const list = Array.isArray(shifts) ? shifts : [];

  // Group each target's appearances (skipping input-driven shifts) in time order.
  const byTarget = new Map();
  for (const sh of list) {
    if (!sh || sh.hadRecentInput) continue;
    const startTime = typeof sh.startTime === 'number' ? sh.startTime : 0;
    for (const src of Array.isArray(sh.sources) ? sh.sources : []) {
      if (!src || typeof src.target !== 'string') continue;
      const key = src.target.trim();
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key).push({ startTime, prev: rectWH(src.previousRect), cur: rectWH(src.currentRect) });
    }
  }

  for (const [target, raw] of byTarget) {
    const entries = raw.slice().sort((a, b) => a.startTime - b.startTime);
    const first = entries[0];
    const last = entries[entries.length - 1];

    // monotonic-growth: currentRect non-decreasing in both dims each step, with
    // meaningful net growth over ≥ REVEAL_MIN_GROWTH_STEPS frames.
    let monotonic = false;
    if (entries.length >= REVEAL_MIN_GROWTH_STEPS) {
      let ok = true;
      for (let i = 1; i < entries.length; i++) {
        if (entries[i].cur.w < entries[i - 1].cur.w - SHIFT_SUBPIXEL_EPSILON
          || entries[i].cur.h < entries[i - 1].cur.h - SHIFT_SUBPIXEL_EPSILON) {
          ok = false;
          break;
        }
      }
      const grewW = last.cur.w - Math.min(first.prev.w, first.cur.w);
      const grewH = last.cur.h - Math.min(first.prev.h, first.cur.h);
      monotonic = ok && grewW > REVEAL_MIN_GROWTH_PX && grewH > REVEAL_MIN_GROWTH_PX;
    }

    // appears-from-zero: revealed from a 0×0 / display:none box, across ≥2 frames
    // (a single one-shot appearance is the generic reserve-space case — not flagged).
    const appearsFromZero = entries.length >= REVEAL_MIN_APPEAR_STEPS
      && first.prev.w <= SHIFT_SUBPIXEL_EPSILON && first.prev.h <= SHIFT_SUBPIXEL_EPSILON
      && last.cur.w > REVEAL_MIN_GROWTH_PX && last.cur.h > REVEAL_MIN_GROWTH_PX;

    if (!monotonic && !appearsFromZero) continue;
    reveals.set(target, {
      mechanism: 'animated-reveal',
      signal: monotonic ? 'monotonic-growth' : 'appears-from-zero',
      steps: entries.length,
      fromRect: first.prev,
      toRect: last.cur,
      startTime: first.startTime,
      endTime: last.startTime,
    });
  }
  return reveals;
}

function c6LabClsShifts(run, ctx, existingFindings) {
  const findings = [];
  const shifts = run && run.cwv && run.cwv.cls && Array.isArray(run.cwv.cls.shifts)
    ? run.cwv.cls.shifts : [];
  if (shifts.length === 0) return findings;

  // Targets already covered by C3 (by selector).
  // Uses selectorsMatch for semantic equivalence — e.g. lab `main#main` ≡ RUM `#main`.
  const covered = [];
  for (const f of existingFindings) {
    if (!Array.isArray(f.metric) || !f.metric.includes('CLS')) continue;
    for (const ev of f.evidence || []) {
      if (!ev || !ev.data) continue;
      if (Array.isArray(ev.data.byElement)) {
        for (const b of ev.data.byElement) if (b && b.target) covered.push(b.target);
      }
      if (typeof ev.data.target === 'string') covered.push(ev.data.target);
      if (typeof ev.data.largestShiftTarget === 'string') covered.push(ev.data.largestShiftTarget);
    }
  }

  const significant = shifts
    .filter((s) => s && !s.hadRecentInput && typeof s.value === 'number'
      && s.value >= MIN_IMPACT.CLS.delta)
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  const loadState = (run && run.cwv && run.cwv.cls && run.cwv.cls.attribution
    && run.cwv.cls.attribution.loadState) || null;

  // V5 — classify animated-reveal targets over ALL shifts (the growth spans many
  // sub-threshold frames, not just the one significant shift that emits a finding).
  const reveals = detectAnimatedReveals(shifts);

  for (const sh of significant) {
    const sources = Array.isArray(sh.sources) ? sh.sources.filter((x) => x && x.target) : [];
    if (sources.length === 0) continue;

    // Classify every source by grown-vs-moved. The *cause* of the shift is
    // whichever source grew; the moved source(s) are victims being pushed by
    // that growth. Prefer the grown source closest to the document start
    // (smallest previousRect.y) — matches the injection-banner pattern where
    // a single ancestor grows and everything below it slides down.
    const classified = sources.map((s) => {
      const c = classifyShiftSource(s);
      return { src: s, ...c };
    });
    const grownSources = classified.filter((c) => c.grew);
    const movedSources = classified.filter((c) => c.moved);

    let primary;
    let movedTarget = null;
    let shiftWithoutGrowth = false;
    if (grownSources.length > 0) {
      grownSources.sort((a, b) => (a.prev.y || 0) - (b.prev.y || 0));
      primary = grownSources[0].src;
      // Record the first moved sibling (if any) as the victim for traceability.
      if (movedSources.length > 0) {
        movedSources.sort((a, b) => (a.prev.y || 0) - (b.prev.y || 0));
        movedTarget = movedSources[0].src.target;
      }
    } else {
      // No source grew (pure repositioning — rare, e.g. explicit margin
      // changes or transform animations). Fall back to the widest-rect
      // source and flag the shape mismatch so the reader doesn't mistake
      // this for an injection-shift case.
      shiftWithoutGrowth = true;
      const byArea = sources.slice().sort((a, b) => {
        const areaA = (a.currentRect && a.currentRect.width * a.currentRect.height) || 0;
        const areaB = (b.currentRect && b.currentRect.width * b.currentRect.height) || 0;
        return areaB - areaA;
      });
      primary = byArea[0];
      if (movedSources.length > 0) {
        movedSources.sort((a, b) => (a.prev.y || 0) - (b.prev.y || 0));
        movedTarget = movedSources[0].src.target;
      }
    }

    if (isSelectorCovered(covered, primary.target)) continue;
    covered.push(primary.target);

    const impactReduction = { metric: 'CLS', score: Number(sh.value.toFixed(3)) };
    const severity = deriveSeverity(impactReduction);

    const otherTargets = sources
      .filter((s) => s.target && s.target !== primary.target)
      .slice(0, 2)
      .map((s) => s.target);
    const siblingsText = otherTargets.length ? ` (also shifted: ${otherTargets.join(', ')})` : '';
    const growthNote = shiftWithoutGrowth
      ? ' (shift-without-growth: no source element grew — likely pure repositioning)'
      : (movedTarget ? `; "${movedTarget}" moved as a result` : '');

    // V5 — is this target an animated reveal (size tweened across frames, or
    // revealed from display:none)? If so the fix is transform/opacity, not just
    // "reserve space", and the space to reserve is the FINAL size (the captured
    // shift may be a mid-animation frame).
    const reveal = reveals.get((primary.target || '').trim());
    const reserveHeight = Math.max(
      0,
      (reveal && reveal.toRect && reveal.toRect.h) || 0,
      (primary.currentRect && primary.currentRect.height) || 0,
    );

    let cause;
    let recommendation;
    if (reveal) {
      const from = reveal.fromRect;
      const to = reveal.toRect;
      const how = reveal.signal === 'monotonic-growth'
        ? `grow ${Math.round(from.w)}×${Math.round(from.h)} → ${Math.round(to.w)}×${Math.round(to.h)} across ${reveal.steps} consecutive frames (${reveal.startTime}–${reveal.endTime}ms)`
        : `appear from a 0×0 / \`display:none\` box to ${Math.round(to.w)}×${Math.round(to.h)} over ${reveal.steps} frames`;
      cause = `Lab observed "${primary.target}" ${how} — an animated reveal that transitions layout-affecting properties (width/height/display), not a static unsized element${siblingsText}${loadState ? `, loadState=${loadState}` : ''}.`;
      const hydratedDefaultAdvice = reveal.signal === 'appears-from-zero'
        ? ' For tabbed/default-state modules, align SSR/static CSS with the hydrated default state and reserve the active panel slot before first paint; DOMContentLoaded-time reservation is too late for CLS.'
        : '';
      recommendation = `Render "${primary.target}" at its final size from first paint and animate ONLY \`transform\`/\`opacity\` (GPU-composited, no reflow). Do not animate \`width\`/\`height\`/\`display\` or use jQuery \`.show(duration)\`/\`.slideDown()\`. To reveal on a condition, toggle a class that changes \`opacity\`/\`transform\` on an already-sized box; for enter/exit transitions use \`@starting-style\` + \`transition-behavior: allow-discrete\`.${hydratedDefaultAdvice} Fallback: reserve the final ${Math.round(reserveHeight)}px.`;
    } else {
      cause = `Lab observed a ${sh.value.toFixed(3)} layout shift at ${sh.startTime}ms caused by "${primary.target}"${growthNote}${siblingsText}${loadState ? `, loadState=${loadState}` : ''}.`;
      recommendation = shiftWithoutGrowth
        ? `Investigate "${primary.target}" — the shift is a pure repositioning (no element grew), so likely an explicit margin/padding change, transform animation, or font-swap reflow. Avoid animating layout-affecting properties; use \`transform\` or \`opacity\` instead.`
        : `Reserve space for "${primary.target}" before it grows. If it's an image, set explicit \`width\`/\`height\` or \`aspect-ratio\`. If it's a late-injected banner/ad/embed (header promo, cookie bar, alert), pre-render a placeholder of the final dimensions. If it's a web-font swap, use \`font-display: optional\` or preload the font.`;
    }

    const evidenceData = {
      valueMs: 0,
      score: Number(sh.value.toFixed(4)),
      startTime: sh.startTime,
      target: primary.target,
      previousRect: primary.previousRect,
      currentRect: primary.currentRect,
      movedTarget,
      shiftWithoutGrowth,
      otherTargets,
      loadState,
    };
    if (reveal) {
      evidenceData.mechanism = reveal.mechanism;
      evidenceData.revealSignal = reveal.signal;
      evidenceData.revealSteps = reveal.steps;
      evidenceData.finalRect = reveal.toRect;
    }

    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-cls-c6-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: 'perf_observer',
      metric: ['CLS'],
      type: 'opportunity',
      severity,
      // G3 — runtime shift sources are the AUTHORITATIVE CLS attribution. The
      // browser observed THIS element grow and produce a measured layout shift,
      // so it's a confirmed root cause (not a static guess). Pure repositioning
      // (no source grew → shiftWithoutGrowth) is a victim being pushed by an
      // unidentified cause, so it is NOT marked rootCause.
      rootCause: !shiftWithoutGrowth,
      cause,
      evidence: [
        { kind: 'cwv-attribution', metric: 'CLS', data: evidenceData },
      ],
      recommendation,
      patches: {
        markup: [
          { selector: primary.target, attrs: { style: `min-height:${Math.round(reserveHeight)}px` } },
        ],
      },
      // Confirmed grown-source shift earns the perf_observer cap (0.85);
      // pure-repositioning (cause unidentified) is held lower.
      confidence: capConfidence('perf_observer', shiftWithoutGrowth ? 0.65 : 0.85),
      impactReduction,
      status: 'proposed',
      mergedSources: ['perf_observer'],
    };

    const v = validateFinding(finding);
    if (v.valid) findings.push(finding);
    else process.stderr.write(`chain-rum-correlator C6: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// C8: Lab transport/cache signal (HTTP/1.x, CDN miss, slow per-resource TTFB)
// ---------------------------------------------------------------------------

function resourceId(r) {
  if (!r || !r.url) return '';
  return `${r.url}\n${r.startTime || 0}\n${r.type || ''}`;
}

function uniqueResources(resources) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(resources) ? resources : []) {
    if (!r || !r.url) continue;
    const key = resourceId(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function resourcesFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  if (Array.isArray(snapshot.all) && snapshot.all.length > 0) return uniqueResources(snapshot.all);
  return uniqueResources([
    ...(snapshot.renderBlocking || []),
    ...(snapshot.preLCP || []),
    ...(snapshot.postLCP || []),
    ...(snapshot.http1 || []),
    ...(snapshot.cdnCacheMiss || []),
    ...Object.values(snapshot.byType || {}).flatMap((list) => Array.isArray(list) ? list : []),
  ]);
}

function isHttp1Protocol(protocol) {
  return /^http\/1(?:\.0|\.1)?$/i.test(String(protocol || ''));
}

function isCacheMissServerTiming(timing) {
  if (!timing) return false;
  const name = String(timing.name || '').toLowerCase();
  const description = String(timing.description || '').toLowerCase();
  return /(cache|cdn|edge)/.test(name)
    && /(miss|expired|stale|bypass|revalidat|fwd=uri-miss)/.test(description);
}

function resourceHasCdnCacheMiss(r) {
  return Array.isArray(r && r.serverTiming) && r.serverTiming.some(isCacheMissServerTiming);
}

function buildResourceSet(list) {
  return new Set(uniqueResources(list).map(resourceId));
}

function isNavigationOrCriticalResource(r, snapshot, criticalIds) {
  if (!r) return false;
  if (criticalIds.has(resourceId(r))) return true;
  if (r.renderBlockingStatus === 'blocking') return true;
  if (r.type === 'navigation' || r.type === 'document') return true;
  if (snapshot && typeof snapshot.lcpTime === 'number' && r.startTime <= snapshot.lcpTime) return true;
  return false;
}

function topUrls(resources) {
  return resources.map((r) => r.url).filter(Boolean).slice(0, 3).join(', ');
}

function highestTtfb(resources) {
  let max = 0;
  for (const r of resources) {
    if (typeof r.ttfb === 'number' && r.ttfb > max) max = r.ttfb;
  }
  return round(max);
}

function c8ConnectionCache(run, ctx) {
  const findings = [];
  const snapshot = run && run.resources;
  if (!snapshot || typeof snapshot !== 'object') return findings;

  const all = resourcesFromSnapshot(snapshot);
  if (all.length === 0) return findings;
  const criticalIds = buildResourceSet([
    ...(snapshot.renderBlocking || []),
    ...(snapshot.preLCP || []),
  ]);

  const http1Critical = uniqueResources(
    (Array.isArray(snapshot.http1) && snapshot.http1.length > 0
      ? snapshot.http1
      : all.filter((r) => isHttp1Protocol(r.nextHopProtocol)))
      .filter((r) => isNavigationOrCriticalResource(r, snapshot, criticalIds)),
  ).sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  if (http1Critical.length > 0) {
    const impactReduction = { metric: 'LCP', valueMs: HTTP1_CRITICAL_IMPACT_MS };
    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-connection-c8-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: 'har',
      metric: ['LCP', 'FCP'],
      type: 'bottleneck',
      severity: deriveSeverity(impactReduction),
      rootCause: true,
      cause: `Lab resource timing shows ${http1Critical.length} render-blocking or pre-LCP resource(s) using HTTP/1.x: ${topUrls(http1Critical)}. HTTP/1.x serializes critical request work and can delay first paint/LCP compared with h2/h3 multiplexing.`,
      evidence: http1Critical.slice(0, 5).map(buildEvidenceResourceTiming),
      recommendation: 'Serve critical document, CSS, font, and LCP-image resources over HTTP/2 or HTTP/3. Check CDN/origin ALPN negotiation and avoid routing critical assets through legacy HTTP/1.1 hosts.',
      confidence: capConfidence('har', 0.80),
      impactReduction,
      status: 'proposed',
      mergedSources: ['har'],
    };
    const v = validateFinding(finding);
    if (v.valid) findings.push(finding);
    else process.stderr.write(`chain-rum-correlator C8: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
  }

  const cdnMissHighTtfb = uniqueResources(
    (Array.isArray(snapshot.cdnCacheMiss) && snapshot.cdnCacheMiss.length > 0
      ? snapshot.cdnCacheMiss
      : all.filter(resourceHasCdnCacheMiss))
      .filter((r) => typeof r.ttfb === 'number'
        && r.ttfb >= CDN_CACHE_MISS_TTFB_MS
        && isNavigationOrCriticalResource(r, snapshot, criticalIds)),
  ).sort((a, b) => (b.ttfb || 0) - (a.ttfb || 0));

  if (cdnMissHighTtfb.length > 0) {
    const topTtfb = highestTtfb(cdnMissHighTtfb);
    const impactReduction = { metric: 'TTFB', valueMs: topTtfb };
    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-cache-c8-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: 'har',
      metric: ['TTFB', 'LCP'],
      type: 'bottleneck',
      severity: deriveSeverity(impactReduction),
      rootCause: true,
      cause: `Lab server-timing shows a CDN/cache miss on ${cdnMissHighTtfb.length} navigation or critical-path resource(s) with TTFB >= ${CDN_CACHE_MISS_TTFB_MS}ms; worst TTFB=${topTtfb}ms (${topUrls(cdnMissHighTtfb)}).`,
      evidence: cdnMissHighTtfb.slice(0, 5).map(buildEvidenceResourceTiming),
      recommendation: 'Fix the critical-path cacheability issue: inspect Cache-Control, Surrogate-Control, Vary, query-string normalization, and origin shield/edge TTL. Navigation and critical assets should hit the CDN unless they are deliberately personalized.',
      confidence: capConfidence('har', 0.85),
      impactReduction,
      status: 'proposed',
      mergedSources: ['har'],
    };
    const v = validateFinding(finding);
    if (v.valid) findings.push(finding);
    else process.stderr.write(`chain-rum-correlator C8: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
  }

  const cacheMissHighTtfbIds = new Set(cdnMissHighTtfb.map(resourceId));
  const slowTtfb = uniqueResources(all)
    .filter((r) => typeof r.ttfb === 'number' && r.ttfb >= SLOW_RESOURCE_TTFB_MS)
    .filter((r) => !cacheMissHighTtfbIds.has(resourceId(r)))
    .sort((a, b) => (b.ttfb || 0) - (a.ttfb || 0));

  if (slowTtfb.length > 0) {
    const topTtfb = highestTtfb(slowTtfb);
    const impactReduction = { metric: 'TTFB', valueMs: topTtfb };
    const finding = {
      schemaVersion: '1.0',
      id: `${ctx.shortName}-ttfb-c8-${ctx.seq++}`,
      timestamp: isoNow(),
      url: ctx.url,
      skill: ctx.skill,
      source: 'har',
      metric: ['TTFB'],
      type: 'bottleneck',
      severity: deriveSeverity(impactReduction),
      rootCause: true,
      cause: `Lab resource timing shows ${slowTtfb.length} resource(s) with per-resource TTFB >= ${SLOW_RESOURCE_TTFB_MS}ms; worst TTFB=${topTtfb}ms (${topUrls(slowTtfb)}).`,
      evidence: slowTtfb.slice(0, 5).map(buildEvidenceResourceTiming),
      recommendation: `Reduce server wait time for the listed resource(s). The documented workbench threshold is ${SLOW_RESOURCE_TTFB_MS}ms per resource; inspect origin latency, CDN cacheability, redirects, and backend dependencies before optimizing transfer size.`,
      confidence: capConfidence('har', 0.80),
      impactReduction,
      status: 'proposed',
      mergedSources: ['har'],
    };
    const v = validateFinding(finding);
    if (v.valid) findings.push(finding);
    else process.stderr.write(`chain-rum-correlator C8: dropped ${finding.id}: ${v.errors.join('; ')}\n`);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// C9: CSP violations as diagnosis evidence for blocked lab patches
// ---------------------------------------------------------------------------

function normalizeCspViolation(v) {
  v = v && typeof v === 'object' ? v : {};
  const str = (value) => (typeof value === 'string' && value ? value : null);
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);
  return {
    violatedDirective: str(v.violatedDirective),
    effectiveDirective: str(v.effectiveDirective),
    blockedURI: str(v.blockedURI),
    sourceFile: str(v.sourceFile),
    lineNumber: num(v.lineNumber),
    columnNumber: num(v.columnNumber),
    disposition: str(v.disposition),
  };
}

function cspViolationsFromRun(run) {
  const list = run && run.cwv && Array.isArray(run.cwv.cspViolations)
    ? run.cwv.cspViolations : [];
  return list.map(normalizeCspViolation);
}

function globToRegex(pattern) {
  const escaped = String(pattern || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function patchRef(source, matchType, value, detail = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return { source, matchType, value: value.trim(), ...detail };
}

function selectorUrlHints(selector) {
  const out = [];
  const re = /\[(?:src|href)[^\]]*=["']([^"']+)["']\]/gi;
  let m;
  while ((m = re.exec(String(selector || ''))) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function extractUrlHints(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return [];
  const urls = [];
  const re = /\bhttps?:\/\/[^\s"'<>\\)]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) urls.push(m[0]);
  const attrRe = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;
  while ((m = attrRe.exec(text)) !== null) {
    const candidate = m[1] || m[2] || m[3] || '';
    if (/^(?:\/|\.\/|\.\.\/)/.test(candidate)) urls.push(candidate);
  }
  return Array.from(new Set(urls));
}

function patchResourceReferences(bundle) {
  const safe = bundle && typeof bundle === 'object' ? bundle : {};
  const refs = [];
  const push = (ref) => { if (ref) refs.push(ref); };

  for (const item of Array.isArray(safe.resources) ? safe.resources : []) {
    if (!item || typeof item !== 'object') continue;
    push(patchRef(item.source || 'resources', item.matchType || 'url', item.value || item.href || item.urlPattern));
  }
  for (const pattern of Array.isArray(safe.block) ? safe.block : []) {
    push(patchRef('block', 'glob', pattern));
  }
  for (const preload of Array.isArray(safe.preloads) ? safe.preloads : []) {
    push(patchRef('preloads', 'url', preload && preload.href, {
      as: preload && preload.as || null,
      fetchpriority: preload && preload.fetchpriority || null,
    }));
  }
  for (const rule of Array.isArray(safe.rewriteBody) ? safe.rewriteBody : []) {
    push(patchRef('rewriteBody', 'glob', rule && rule.urlPattern));
    for (const url of Array.isArray(rule && rule.injectedUrls) ? rule.injectedUrls : []) {
      push(patchRef('rewriteBody.injectedUrls', 'url', url));
    }
    for (const replacement of Array.isArray(rule && rule.replacements) ? rule.replacements : []) {
      for (const url of extractUrlHints(replacement && replacement.replace)) {
        push(patchRef('rewriteBody.replacements', 'url', url));
      }
    }
  }
  for (const rule of Array.isArray(safe.requestHeaders) ? safe.requestHeaders : []) {
    push(patchRef('requestHeaders', 'glob', rule && rule.urlPattern));
  }
  for (const rule of Array.isArray(safe.responseHeaders) ? safe.responseHeaders : []) {
    push(patchRef('responseHeaders', 'glob', rule && rule.urlPattern));
  }
  for (const mutation of Array.isArray(safe.markup) ? safe.markup : []) {
    if (!mutation || typeof mutation !== 'object') continue;
    for (const hint of selectorUrlHints(mutation.selector)) {
      push(patchRef('markup.selector', 'contains', hint, { selector: mutation.selector || null }));
    }
    const attrs = mutation.attrs && typeof mutation.attrs === 'object' ? mutation.attrs : {};
    for (const key of ['src', 'href']) {
      push(patchRef('markup.attrs', 'url', attrs[key], { selector: mutation.selector || null, attr: key }));
    }
  }

  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.source}\n${ref.matchType}\n${ref.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function absoluteUrlLike(value, pageUrl) {
  try { return new URL(value, pageUrl || 'https://example.com/').href; } catch { return null; }
}

function patchRefMatchesBlockedUri(ref, blockedURI, pageUrl) {
  if (!ref || !blockedURI) return false;
  const blocked = String(blockedURI);
  const value = String(ref.value || '');
  if (!value) return false;
  if (ref.matchType === 'glob' || value.includes('*')) {
    try { return globToRegex(value).test(blocked); } catch { return false; }
  }
  const blockedAbs = absoluteUrlLike(blocked, pageUrl);
  const valueAbs = absoluteUrlLike(value, pageUrl);
  if (blockedAbs && valueAbs && blockedAbs === valueAbs) return true;
  if (blocked === value) return true;
  return ref.matchType === 'contains' && blocked.includes(value);
}

function correlateCspViolations(run, patchBundle, ctx) {
  const violations = cspViolationsFromRun(run);
  const refs = patchResourceReferences(patchBundle);
  const blockedPatches = [];
  for (const violation of violations) {
    if (!violation.blockedURI) continue;
    for (const ref of refs) {
      if (!patchRefMatchesBlockedUri(ref, violation.blockedURI, ctx && ctx.url)) continue;
      blockedPatches.push({ violation, patch: ref });
      break;
    }
  }
  return {
    violations,
    patchedResourceCount: refs.length,
    blockedPatches,
  };
}

function buildCspViolationEvidence(match) {
  return {
    kind: 'csp-violation',
    data: {
      ...match.violation,
      matchedPatch: {
        source: match.patch.source,
        matchType: match.patch.matchType,
        value: match.patch.value,
        selector: match.patch.selector || null,
        attr: match.patch.attr || null,
      },
    },
  };
}

function annotateFindingsWithCspEvidence(findings, cspDiagnostics, ctx) {
  if (!cspDiagnostics || !Array.isArray(cspDiagnostics.blockedPatches)
    || cspDiagnostics.blockedPatches.length === 0) {
    return;
  }
  for (const finding of findings) {
    if (!finding || !finding.patches) continue;
    const refs = patchResourceReferences(finding.patches);
    if (refs.length === 0) continue;
    for (const match of cspDiagnostics.blockedPatches) {
      const matchedFindingPatch = refs.some((ref) => (
        patchRefMatchesBlockedUri(ref, match.violation.blockedURI, ctx && ctx.url)
      ));
      if (!matchedFindingPatch) continue;
      finding.evidence.push(buildCspViolationEvidence(match));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Correlate lab waterfall/cwv data against a Helix RUM bundle summary.
 *
 * @param {object} input
 * @param {object} input.rumBundle        - Parsed output of rum-fetch.js.
 * @param {object} input.launcherOutput   - Parsed output of launcher.js.
 * @param {object[]} [input.htmlFindings] - Optional array of html-parse findings.
 * @param {object} [opts]
 * @param {string} [opts.skill="cwv-diagnose"]
 * @param {number} [opts.runIndex=0]
 * @param {string} [opts.flavor]            - stack flavor / SpaceCat deliveryType. When set,
 *                                            each finding is tagged with an `owner` (G5 attribution).
 * @param {object} [opts.responseHeaders]   - optional document response headers for the dispatcher/CDN signal.
 * @returns {{ findings: object[], summary: string }}
 */
function correlateChains(input, opts) {
  opts = opts || {};
  input = input || {};
  const rumBundle = input.rumBundle;
  const launcherOutput = input.launcherOutput;
  const htmlFindings = input.htmlFindings;

  const skill = opts.skill || 'cwv-diagnose';
  const runIndex = typeof opts.runIndex === 'number' ? opts.runIndex : 0;
  const flavor = opts.flavor ? normalizeFlavor(opts.flavor) : null;

  if (!launcherOutput || typeof launcherOutput !== 'object') {
    return { findings: [], summary: 'No launcher output supplied.' };
  }
  // rumBundle is optional — when absent, the lab-driven heuristics (C5-C8) still fire
  // from the event logs captured by measure-cwv.js.
  const haveRum = rumBundle && typeof rumBundle === 'object';

  const run = pickRun(launcherOutput, runIndex);
  if (!run) {
    return { findings: [], summary: `No lab run at index ${runIndex}.` };
  }

  const pageUrl = launcherOutput.url
    || (run.cwv && run.cwv.url)
    || (rumBundle.byUrl && rumBundle.byUrl[0] && rumBundle.byUrl[0].url)
    || `https://${rumBundle.domain || safeDomain('')}/`;

  const ctx = {
    skill,
    url: pageUrl,
    shortName: skill.replace(/^cwv-/, ''),
    seq: 1,
  };
  const patchBundle = opts.patchBundle || input.patchBundle
    || launcherOutput.appliedPatches || launcherOutput.patches || {};
  const cspDiagnostics = correlateCspViolations(run, patchBundle, ctx);

  const findings = [];
  const addAll = (arr) => arr.forEach((f) => findings.push(f));
  if (haveRum) {
    addAll(c1InpChain(rumBundle, run, ctx));
    addAll(c2LcpResource(rumBundle, run, ctx));
    addAll(c3ClsImage(rumBundle, run, ctx, htmlFindings));
    addAll(c4Disagreement(rumBundle, run, ctx));
  }
  // C5/C7/C8/C6 run regardless of RUM — they walk the lab event logs and dedupe
  // against whatever C1/C3 already emitted.
  addAll(c5LabInpInteractions(run, ctx, findings));
  addAll(c7FontFaces(run, ctx, findings));
  addAll(c8ConnectionCache(run, ctx));
  addAll(c6LabClsShifts(run, ctx, findings));
  annotateFindingsWithCspEvidence(findings, cspDiagnostics, ctx);

  // G5 — platform-vs-customer attribution. Only when a flavor is known: tag
  // each finding with an `owner` derived from playbook applicable_flavors +
  // stack + evidence. No-op (findings unchanged) when flavor is absent, so
  // existing callers and tests are unaffected. Defensive — never let an
  // attribution hiccup drop a finding.
  if (flavor) {
    for (let i = 0; i < findings.length; i += 1) {
      try {
        findings[i] = attributeFinding(findings[i], { flavor, responseHeaders: opts.responseHeaders });
      } catch (e) {
        process.stderr.write(`chain-rum-correlator: attribution skipped for ${findings[i].id}: ${e.message}\n`);
      }
    }
  }

  const active = findings.filter((f) => f.status !== 'rejected');
  const summaryParts = [
    `chain-rum-correlator for ${ctx.url}`,
    `emitted ${findings.length} finding(s), ${active.length} actionable`,
    `breakdown: ${['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((c) => `${c}=${findings.filter((f) => f.id.includes(`-${c}-`)).length}`).join(' ')}`,
    `cspBlockedPatches=${cspDiagnostics.blockedPatches.length}`,
  ];
  if (flavor) {
    const owners = {};
    for (const f of findings) if (f.owner) owners[f.owner] = (owners[f.owner] || 0) + 1;
    summaryParts.push(`owner (${flavor}): ${Object.entries(owners).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
  }
  const summary = summaryParts.join(' — ');

  return { findings, summary, diagnostics: { csp: cspDiagnostics } };
}

export { correlateChains, detectAnimatedReveals, correlateCspViolations };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { rum: null, launcher: null, html: null, output: null, flavor: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--rum': args.rum = argv[++i]; break;
      case '--launcher': args.launcher = argv[++i]; break;
      case '--html': args.html = argv[++i]; break;
      case '--output': args.output = argv[++i]; break;
      case '--flavor':
      case '--delivery-type': args.flavor = argv[++i]; break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        process.stderr.write(`Unknown flag: ${a}\n`);
        process.exit(64);
    }
  }
  return args;
}

function printHelp() {
  const help = `
chain-rum-correlator.js — Correlate Helix RUM field signal with lab waterfall/CWV evidence.

Usage:
  node .agents/scripts/analyzers/chain-rum-correlator.js --rum <path> --launcher <path> [flags]

Flags:
  --rum <path>         Parsed rum-fetch.js JSON output (required).
  --launcher <path>    Parsed launcher.js JSON output (required).
  --html <path>        Optional html-parse findings array (for C3 missing-dimensions hint).
  --output <path>      Write envelope JSON to path (default: stdout).
  --flavor <t>         Stack flavor / SpaceCat deliveryType (eds|cs|ams|headless, aem_cs, ...).
                       When set, tags each finding with an \`owner\` (G5 attribution).
  --help, -h           Show this help.

Exit codes:
  0   Success (may emit 0 findings)
  64  Invalid CLI usage
  65  Input file not readable or not JSON
`;
  process.stdout.write(help.trimStart());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  if (!args.rum || !args.launcher) {
    process.stderr.write('Error: --rum and --launcher are required.\n');
    process.exit(64);
  }
  function readJson(p) {
    try { return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), p), 'utf8')); }
    catch (e) {
      process.stderr.write(`Error reading ${p}: ${e.message}\n`);
      process.exit(65);
    }
  }
  const rumBundle = readJson(args.rum);
  const launcherOutput = readJson(args.launcher);
  const htmlFindings = args.html ? readJson(args.html) : null;

  const out = correlateChains({ rumBundle, launcherOutput, htmlFindings }, { flavor: args.flavor });
  const envelope = {
    schemaVersion: '1.0',
    skill: 'cwv-diagnose',
    url: launcherOutput.url || (rumBundle.byUrl && rumBundle.byUrl[0] && rumBundle.byUrl[0].url) || 'https://example.com/',
    timestamp: isoNow(),
    findings: out.findings,
    summary: out.summary,
  };
  if (out.diagnostics && out.diagnostics.csp
    && (out.diagnostics.csp.violations.length || out.diagnostics.csp.blockedPatches.length)) {
    envelope.diagnostics = out.diagnostics;
  }
  const json = JSON.stringify(envelope, null, 2);
  if (args.output) {
    const dir = path.dirname(args.output);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(args.output, `${json}\n`, 'utf8');
    process.stderr.write(`Wrote ${args.output}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  process.stderr.write(`${out.summary}\n`);
}
