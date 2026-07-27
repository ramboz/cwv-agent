#!/usr/bin/env node


import 'dotenv/config';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { KnownDevices } from 'puppeteer';

import { buildBlockPredicate } from './patches/block-resource.js';
import { buildPreloadHeaderTransformer } from './patches/inject-preload.js';
import {
  buildRequestHeaderTransformer,
  buildResponseHeaderTransformer,
} from './patches/rewrite-headers.js';
import { buildMarkupMutationScript } from './patches/mutate-markup.js';
import { describePatchModes } from './patches/patch-modes.js';
import {
  CONSENT_ACCEPT_SELECTORS,
  DEFAULT_SCROLL_OPTS,
  aggregateClsByNode,
  windowedCls,
  scrollAndSettleInPage,
  dismissConsent,
} from './field-measure.js';
import { assessLauncherOutput, DEFAULTS as QUALITY_DEFAULTS } from './measure-quality.js';
import { buildLaunchOptions, applyStealthPage } from './launch-opts.js';
import { checkPreflight, formatPreflightGate } from './preflight.js';

// ---------------------------------------------------------------------------
// Profiles (aligned with Lighthouse/PSI "Mobile Slow 4G" calibration)
// ---------------------------------------------------------------------------
import { PROFILES, applyProfile } from './profiles.js';

const DEFAULT_STRUCTURE_SNAPSHOT_LIMIT = 10;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = `
cwv-agent launcher

Usage: node .agents/scripts/launcher.js --url <URL> [flags]

Flags:
  --url <url>               Target page URL (required)
  --profile <name>          Throttling profile (default: mobile-slow4g-4xcpu)
                            Options: mobile-slow4g-4xcpu | desktop-cable-1xcpu |
                            desktop-slow-1xcpu | no-throttle. desktop-slow-1xcpu
                            is an opt-in for cold-load desktop CLS repro (slow
                            link + cold cache) that desktop-cable-1xcpu misses.
  --runs <N>                Number of cold-cache runs (default: 1). With --max-runs,
                            this is the minimum (floor) before the adaptive early-exit.
  --max-runs <N>            Adaptive cap: keep running past --runs until every
                            reliability metric has enough stable samples, or this
                            cap is hit. Emits a measurementQuality block. (default: =--runs)
  --min-samples <N>         Samples per metric needed to call it reliable (default: 3).
                            Also the success floor: the batch exits non-zero only if
                            it can't reach this many SUCCESSFUL runs (capped at --runs).
  --max-failures <N>        Failed runs to tolerate before giving up (default:
                            max(2, --runs)). A failed run (e.g. a nav timeout on a
                            flaky slow target) is skipped/retried, not fatal. 0 =
                            strict abort on the first failure.
  --nav-timeout <ms>        Per-navigation timeout (default: 60000). Raise for very
                            slow cold targets (the news-site case cold LCP up to 11 s on slow-4G).
  --reliability-metrics <l> Comma list the adaptive loop waits to stabilize
                            (default: LCP,CLS,FCP,TTFB; +INP when --interact)
  --block <glob,...>        Comma-separated URL globs to block (ad/3p noise).
                            Merges with any block list in --patches.
  --patches <path>          Path to a patches.json bundle (optional)
  --no-scroll               Disable field-faithful mode (load-only). By DEFAULT the
                            launcher scrolls to the bottom in steps and settles to
                            layout/network quiescence, capturing the post-load CLS
                            that dominates the field (scroll-lazy ads, late/consent
                            banners) — this is the field-faithful CLS of record.
                            Pass --no-scroll for a fast load-only run (e.g. an
                            LCP/INP-only experiment batch) to skip the scroll cost.
  --scroll                  Force field-faithful mode on (this is the default;
                            accepted for explicitness).
  --consent <mode>          dismiss | none. Best-effort consent dismissal in
                            scroll mode (default: dismiss in scroll mode, else none)
  --cohort <mode>           first-visit | returning. first-visit = banner shows
                            (cold). returning = pre-accept consent (throwaway load
                            + dismiss, then measure a reload — no banner). Real
                            field CLS is a blend; measure each. (default: first-visit)
  --interact <selector>     CSS selector to click after load (for INP measurement)
  --interact-delay <ms>     Delay after click before snapshot (default: 500)
  --structure-snapshot  Capture an additive page-structure snapshot in
                            the measured page context: body.appear, first
                            sections, header/main overlap, and visible unloaded
                            blocks. Disabled by default.
  --structure-snapshot-limit <N>
                            Number of top-level main sections to include in the
                            structure snapshot (default: ${DEFAULT_STRUCTURE_SNAPSHOT_LIMIT}).
  --screenshot <path>       Full-page PNG screenshot path (optional)
  --dom-snapshot-selector <list>
                            Comma-separated CSS selectors to snapshot from the
                            measured page after scroll/interaction settle. Adds
                            runs[].domSnapshot with rects, computed styles,
                            parent summary, redacted attributes, and redacted
                            trimmed outerHTML/text.
                            Comma lists are for simple selectors; complex
                            selector lists containing commas are not supported.
                            Useful when html-parse is blocked but the launcher
                            reaches the real page.
  --output <path>           Write JSON output to file (default: stdout)
  --stealth                 Launch HEADFUL real Chrome (channel:chrome) with the
                            automation tells scrubbed (no --enable-automation,
                            --disable-blink-features=AutomationControlled,
                            navigator.webdriver patched), to pass Cloudflare /
                            anti-bot managed challenges (e.g. the pharma case-family domains
                            where default headless gets a 403 "Just a moment" stub).
                            NOTE: opens a real Chrome window per run — this is
                            mandatory; headless:'new' with the same scrub still 403s.
                            Mobile profiles use an Android-Chrome UA so the UA matches
                            the Chromium runtime/TLS (an iOS UA would re-trip CF).
                            See references/topics/anti-bot-measurement.md.
  --intercept <mode>        fulfill (default) | passthrough. passthrough releases
                            every response via Fetch.continueResponse with NO body
                            round-trip (no getResponseBody/fulfillRequest) — arm 1 of
                            ADR-0003's 3-arm interception-neutrality probe. Default
                            fulfill is the normal patch/measure path (unchanged).
  --preflight-profile <name>
                            ADR-0014 opt-in preflight: before measurement starts,
                            run npm run doctor's checks for this EXECUTION/PROVIDER
                            profile (doctor.js vocabulary: local, field-google,
                            stealth-headful — NOT the --profile throttle
                            profile above) and refuse to start if a required
                            prerequisite is missing. Omit this flag (the default)
                            for a true no-op — no doctor call at all. Callers that
                            invoke launcher.js many times per session (e.g.
                            cwv-orchestrate's candidate-racing loop) should pass
                            this only on the first/baseline call, not on every
                            repeated call, to avoid paying doctor's checks
                            (subprocess spawns) dozens of times per run.
  --skip-preflight          Bypass --preflight-profile's gate explicitly. Visible
                            in output (stderr) so a bypassed run is never silently
                            indistinguishable from a gated one (ADR-0014 AC4).
  --help                    Print this help and exit 0

Output: JSON document with shape:
  { url, profile, runs: [ { cwv, resources, timestamp }, ... ] }
`;

function parseArgs(argv) {
  const args = {
    url: null,
    profile: 'mobile-slow4g-4xcpu',
    runs: 1,
    maxRuns: null,
    minSamples: QUALITY_DEFAULTS.minSamples,
    maxFailures: null, // null → computeRunPlan supplies a floor-scaled default
    navTimeout: 60000,
    reliabilityMetrics: null,
    block: [],
    patches: null,
    scroll: true, // field-faithful by default (ROADMAP G1); --no-scroll for load-only
    consent: null,
    cohort: 'first-visit',
    interact: null,
    interactDelay: 500,
    domSnapshotSelectors: [],
    structureSnapshot: false,
    structureSnapshotLimit: DEFAULT_STRUCTURE_SNAPSHOT_LIMIT,
    screenshot: null,
    output: null,
    stealth: false,
    preflightProfile: null,
    skipPreflight: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--help': case '-h': args.help = true; break;
      case '--url': args.url = next(); break;
      case '--profile': args.profile = next(); break;
      case '--runs': args.runs = parseInt(next(), 10); break;
      case '--max-runs': args.maxRuns = parseInt(next(), 10); break;
      case '--min-samples': args.minSamples = parseInt(next(), 10); break;
      case '--max-failures': args.maxFailures = parseInt(next(), 10); break;
      case '--nav-timeout': args.navTimeout = parseInt(next(), 10); break;
      case '--reliability-metrics': {
        const v = next() || '';
        args.reliabilityMetrics = v.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--block': {
        const v = next() || '';
        args.block = v.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--patches': args.patches = next(); break;
      case '--scroll': args.scroll = true; break;
      case '--no-scroll': args.scroll = false; break;
      case '--consent': args.consent = next(); break;
      case '--cohort': args.cohort = next(); break;
      case '--interact': args.interact = next(); break;
      case '--interact-delay': args.interactDelay = parseInt(next(), 10); break;
      case '--structure-snapshot': args.structureSnapshot = true; break;
      case '--structure-snapshot-limit': args.structureSnapshotLimit = parseInt(next(), 10); break;
      case '--screenshot': args.screenshot = next(); break;
      case '--dom-snapshot-selector':
      case '--dom-snapshot-selectors': {
        args.domSnapshotSelectors.push(...normalizeDomSnapshotSelectors(next()));
        break;
      }
      case '--output': args.output = next(); break;
      case '--stealth': args.stealth = true; break;
      case '--intercept': args.intercept = next(); break;
      case '--preflight-profile': args.preflightProfile = next(); break;
      case '--skip-preflight': args.skipPreflight = true; break;
      default:
        if (a && a.startsWith('--')) {
          process.stderr.write(`Unknown flag: ${a}\n`);
          process.exit(2);
        }
    }
  }
  return args;
}

function normalizeDomSnapshotSelectors(value) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : []);
  return list
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

const DOM_SNAPSHOT_REDACTION = {
  sensitiveName: '(password|passwd|pwd|token|secret|session|auth|credential|email|phone|tel|address|ssn|dob|birth|first[-_ ]?name|last[-_ ]?name|account|member|patient|zip|postal)',
  email: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
  phone: '\\+?[0-9][0-9 .()\\-]{7,}[0-9]',
  longNumber: '\\b[0-9][0-9 -]{8,}[0-9]\\b',
  bearerOrJwt: '\\b(?:Bearer\\s+)?[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}(?:\\.[A-Za-z0-9_-]{10,})?\\b',
};

function redactDomSnapshotString(value) {
  if (typeof value !== 'string' || value === '') return value;
  return value
    .replace(new RegExp(DOM_SNAPSHOT_REDACTION.email, 'gi'), '[redacted-email]')
    .replace(new RegExp(DOM_SNAPSHOT_REDACTION.longNumber, 'g'), '[redacted-number]')
    .replace(new RegExp(DOM_SNAPSHOT_REDACTION.phone, 'g'), '[redacted-phone]')
    .replace(new RegExp(DOM_SNAPSHOT_REDACTION.bearerOrJwt, 'g'), '[redacted-token]');
}

function shouldRedactDomSnapshotAttribute(name, value = '') {
  const sensitive = new RegExp(DOM_SNAPSHOT_REDACTION.sensitiveName, 'i');
  return sensitive.test(String(name || '')) || sensitive.test(String(value || ''));
}

/**
 * Resolve the run loop's bounds (ROADMAP V2). Pure — no I/O.
 *
 * A single nav timeout on a flaky slow target used to abort the whole batch.
 * The loop now keeps attempting until it has `targetSuccesses` SUCCESSFUL runs
 * or it exhausts `attemptCap`, skipping/retrying failures rather than aborting.
 * The measurement is "usable" (exit 0) once it reaches `requiredSuccesses` —
 * `--min-samples`, but never more than the user actually asked to run.
 *
 * @param {object} o
 * @param {number} [o.runs=1]        success floor (and target when non-adaptive)
 * @param {number} [o.maxRuns]       adaptive cap (≥ runs); enables early-exit-when-reliable
 * @param {number} [o.minSamples=3]  samples needed to call a metric reliable
 * @param {number} [o.maxFailures]   tolerated failed attempts; default max(2, floorRuns)
 * @returns {{ floorRuns, capRuns, adaptive, minSamples, targetSuccesses,
 *            requiredSuccesses, maxFailures, attemptCap }}
 */
function computeRunPlan({ runs, maxRuns, minSamples, maxFailures } = {}) {
  const floorRuns = Number.isFinite(runs) && runs > 0 ? runs : 1;
  const capRuns = Math.max(floorRuns, Number.isFinite(maxRuns) ? maxRuns : floorRuns);
  const adaptive = capRuns > floorRuns;
  const min = Number.isFinite(minSamples) && minSamples > 0 ? minSamples : QUALITY_DEFAULTS.minSamples;
  // Usable measurement floor: min-samples, but you can never need more successful
  // runs than were requested (a --runs 1 pass is usable at 1).
  const requiredSuccesses = Math.min(min, capRuns);
  // Failed attempts to tolerate before giving up; scales with the floor so a
  // 5-run batch can absorb a few flaky timeouts. 0 restores strict abort-on-fail.
  const tolerated = Number.isFinite(maxFailures) && maxFailures >= 0
    ? maxFailures
    : Math.max(2, floorRuns);
  return {
    floorRuns,
    capRuns,
    adaptive,
    minSamples: min,
    targetSuccesses: capRuns,
    requiredSuccesses,
    maxFailures: tolerated,
    attemptCap: capRuns + tolerated,
  };
}

/**
 * Exit code for the batch: 0 once enough successful runs accrued to be usable,
 * else 1 (couldn't reach the min-samples floor — a genuine measurement failure,
 * not a single flaky run).
 *
 * @param {number} successCount
 * @param {{ requiredSuccesses: number }} plan
 * @returns {0|1}
 */
function decideLauncherExit(successCount, plan) {
  return successCount >= plan.requiredSuccesses ? 0 : 1;
}

function normalizeEdsStructureSnapshotOptions(options = {}) {
  const rawLimit = Number(options && options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(50, Math.floor(rawLimit))
    : DEFAULT_STRUCTURE_SNAPSHOT_LIMIT;
  const phase = typeof options.phase === 'string' && options.phase.trim()
    ? options.phase.trim()
    : 'snapshot';
  return { limit, phase };
}

function captureEdsStructureSnapshotInPage(options = {}) {
  const rawLimit = Number(options && options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(50, Math.floor(rawLimit))
    : 10;
  const phase = typeof options.phase === 'string' && options.phase.trim()
    ? options.phase.trim()
    : 'snapshot';

  function rectToJson(rect) {
    if (!rect) return null;
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    };
  }

  function attrs(node, names) {
    const out = {};
    for (const name of names) {
      const value = node && node.getAttribute ? node.getAttribute(name) : null;
      if (value !== null) out[name] = value;
    }
    return out;
  }

  function textOf(node) {
    return (node && node.textContent ? node.textContent : '').trim().replace(/\s+/g, ' ');
  }

  function classesOf(node) {
    return node && node.classList ? Array.from(node.classList) : [];
  }

  function isPlaceholder(classes) {
    return classes.some((cls) => [
      'css-block',
      'metadata',
      'section-metadata',
      'spacer',
      'spacer-and-divider',
      'transparent-block',
    ].includes(cls));
  }

  function sectionKind(classes) {
    if (isPlaceholder(classes)) return 'placeholder';
    if (classes.includes('tabs') || classes.some((cls) => /\btabs?\b/i.test(cls))) return 'tab-shell';
    return 'content';
  }

  function isVisible(computed, rect) {
    return computed
      && computed.display !== 'none'
      && computed.visibility !== 'hidden'
      && Number(computed.opacity || 1) !== 0
      && rect
      && rect.width > 0
      && rect.height > 0;
  }

  function directElementChildren(node) {
    return Array.from(node ? node.children : []).filter((child) => (
      child && child.nodeType === Node.ELEMENT_NODE
    ));
  }

  function likelyBlockNodes(section) {
    const seen = new Set();
    const out = [];
    const add = (node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE || seen.has(node)) return;
      seen.add(node);
      out.push(node);
    };
    Array.from(section.querySelectorAll('[data-block-status],[data-block-name]')).forEach(add);
    for (const child of directElementChildren(section)) {
      const childClasses = classesOf(child);
      const likelyWrappedBlock = child.tagName
        && child.tagName.toLowerCase() === 'div'
        && childClasses.length > 0
        && !isPlaceholder(childClasses);
      if (likelyWrappedBlock) add(child);
    }
    return out;
  }

  const main = document.querySelector('main');
  const header = document.querySelector('header');
  const bodyClasses = classesOf(document.body);
  const mainRect = main ? main.getBoundingClientRect() : null;
  const headerRect = header ? header.getBoundingClientRect() : null;
  const headerStyle = header ? window.getComputedStyle(header) : null;
  const sections = main ? Array.from(main.children).filter((node) => (
    node && node.nodeType === Node.ELEMENT_NODE
  )).slice(0, limit) : [];

  const sectionSnapshots = sections.map((section, index) => {
    const computed = window.getComputedStyle(section);
    const rect = section.getBoundingClientRect();
    const classes = classesOf(section);
    const text = textOf(section);
    const kind = sectionKind(classes);
    const hasMedia = !!section.querySelector('picture,img,video');
    const hasHeading = !!section.querySelector('h1,h2,h3');
    const meaningful = kind === 'content' && (hasHeading || hasMedia || text.length >= 80);
    const blocks = likelyBlockNodes(section).slice(0, 12).map((block) => {
      const blockRect = block.getBoundingClientRect();
      const blockStyle = window.getComputedStyle(block);
      const explicitStatus = block.getAttribute('data-block-status');
      return {
        tagName: block.tagName ? block.tagName.toLowerCase() : null,
        id: block.id || null,
        className: typeof block.className === 'string' ? block.className : '',
        dataBlockName: block.getAttribute('data-block-name') || null,
        status: explicitStatus,
        statusState: explicitStatus || 'absent',
        visible: isVisible(blockStyle, blockRect),
        rect: rectToJson(blockRect),
      };
    });
    return {
      index: index + 1,
      tagName: section.tagName ? section.tagName.toLowerCase() : null,
      id: section.id || null,
      className: typeof section.className === 'string' ? section.className : '',
      classes,
      kind,
      meaningful,
      text: text.slice(0, 220),
      textLength: text.length,
      hasMedia,
      hasHeading,
      rect: rectToJson(rect),
      attributes: attrs(section, ['id', 'class', 'style', 'data-section-status', 'data-block-status']),
      computed: {
        display: computed.display,
        visibility: computed.visibility,
        opacity: computed.opacity,
        position: computed.position,
        minHeight: computed.minHeight,
        height: computed.height,
        paddingTop: computed.paddingTop,
        paddingBottom: computed.paddingBottom,
        marginTop: computed.marginTop,
        marginBottom: computed.marginBottom,
      },
      blocks,
    };
  });

  const firstMeaningful = sectionSnapshots.find((section) => section.meaningful) || null;
  const visibleUnloadedBlocks = [];
  for (const section of sectionSnapshots) {
    for (const block of section.blocks) {
      if (block.visible && block.status !== 'loaded') {
        visibleUnloadedBlocks.push({
          sectionIndex: section.index,
          tagName: block.tagName,
          id: block.id,
          className: block.className,
          dataBlockName: block.dataBlockName,
          status: block.status,
          statusState: block.statusState,
          rect: block.rect,
        });
      }
    }
  }

  const headerOverlapsMain = !!(headerRect && mainRect
    && headerRect.height > 0
    && headerRect.bottom > mainRect.top
    && headerRect.top <= mainRect.top
    && ['fixed', 'absolute', 'sticky'].includes(headerStyle.position));

  return {
    requested: true,
    phase,
    limit,
    body: {
      className: document.body ? document.body.className : '',
      appear: bodyClasses.includes('appear'),
    },
    main: main ? {
      rect: rectToJson(mainRect),
      childElementCount: main.childElementCount,
    } : null,
    header: header ? {
      rect: rectToJson(headerRect),
      computed: {
        display: headerStyle.display,
        visibility: headerStyle.visibility,
        position: headerStyle.position,
        zIndex: headerStyle.zIndex,
        height: headerStyle.height,
      },
      overlapsMain: headerOverlapsMain,
    } : null,
    firstMeaningfulSection: firstMeaningful ? {
      index: firstMeaningful.index,
      id: firstMeaningful.id,
      className: firstMeaningful.className,
      text: firstMeaningful.text,
    } : null,
    visibleUnloadedBlocks,
    sections: sectionSnapshots,
  };
}

// ---------------------------------------------------------------------------
// Patch bundle parsing -> predicate + transformer composition
// ---------------------------------------------------------------------------
function loadPatchBundle(patchesPath) {
  if (!patchesPath) return {};
  const abs = path.resolve(patchesPath);
  const raw = fs.readFileSync(abs, 'utf8');
  return JSON.parse(raw);
}

function isNonEmptyPatchBundle(bundle) {
  return !!(bundle && typeof bundle === 'object' && Object.keys(bundle).some((key) => {
    const value = bundle[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  }));
}

function extractUrlHints(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return [];
  const urls = [];
  const re = /\bhttps?:\/\/[^\s"'<>\\)]+/gi;
  let match;
  while ((match = re.exec(text)) !== null) urls.push(match[0]);
  const attrRe = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;
  while ((match = attrRe.exec(text)) !== null) {
    const candidate = match[1] || match[2] || match[3] || '';
    if (/^(?:\/|\.\/|\.\.\/)/.test(candidate)) urls.push(candidate);
  }
  return Array.from(new Set(urls));
}

function summarizePatchBundle(bundle) {
  const safe = bundle && typeof bundle === 'object' ? bundle : {};
  const copyList = (key, mapper) => (Array.isArray(safe[key]) ? safe[key].map(mapper).filter(Boolean) : []);
  const summary = {
    block: copyList('block', (pattern) => (typeof pattern === 'string' && pattern ? pattern : null)),
    preloads: copyList('preloads', (item) => (
      item && typeof item === 'object' && item.href
        ? { href: item.href, as: item.as || null, fetchpriority: item.fetchpriority || null }
        : null
    )),
    rewriteBody: copyList('rewriteBody', (item) => {
      if (!item || typeof item !== 'object' || !item.urlPattern) return null;
      const injectedUrls = [];
      for (const replacement of Array.isArray(item.replacements) ? item.replacements : []) {
        for (const url of extractUrlHints(replacement && replacement.replace)) injectedUrls.push(url);
      }
      return {
        urlPattern: item.urlPattern,
        injectedUrls: Array.from(new Set(injectedUrls)),
      };
    }),
    markup: copyList('markup', (item) => {
      if (!item || typeof item !== 'object') return null;
      const attrs = {};
      for (const key of ['src', 'href']) {
        if (item.attrs && item.attrs[key] !== undefined && item.attrs[key] !== null) {
          attrs[key] = String(item.attrs[key]);
        }
      }
      return {
        selector: typeof item.selector === 'string' ? item.selector : null,
        attrs,
      };
    }),
    requestHeaders: copyList('requestHeaders', (item) => (
      item && typeof item === 'object' && item.urlPattern
        ? { urlPattern: item.urlPattern }
        : null
    )),
    responseHeaders: copyList('responseHeaders', (item) => (
      item && typeof item === 'object' && item.urlPattern
        ? { urlPattern: item.urlPattern }
        : null
    )),
  };
  summary.counts = Object.fromEntries(Object.entries(summary)
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => [key, value.length]));
  summary.applied = Object.values(summary.counts).some((count) => count > 0);
  return summary;
}

function composePatchHandlers(bundle) {
  const safe = bundle || {};
  const blockPredicate = buildBlockPredicate(safe.block || []);
  const requestHeaderTransformer = buildRequestHeaderTransformer(safe.requestHeaders || []);
  const responseHeaderTransformer = buildResponseHeaderTransformer(safe.responseHeaders || []);
  const preloadLinkHeader = buildPreloadHeaderTransformer(safe.preloads || []);
  const bodyRewrites = Array.isArray(safe.rewriteBody) ? safe.rewriteBody : [];

  // Body rewriter: simple urlPattern match + string replace rules.
  // Rule format: { urlPattern, replacements: [{ find, replace, isRegex? }] }
  function globToRegex(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$');
  }
  const compiledBody = bodyRewrites.map((r) => ({
    regex: globToRegex(r.urlPattern || '*'),
    replacements: Array.isArray(r.replacements) ? r.replacements : [],
  }));

  function bodyRewriter(event, body) {
    if (!body || compiledBody.length === 0) return null;
    const url = (event && event.request && event.request.url) || '';
    let changed = false;
    let decoded;
    try { decoded = Buffer.from(body, 'base64').toString('utf8'); } catch { return null; }
    for (const rule of compiledBody) {
      if (!rule.regex.test(url)) continue;
      for (const rep of rule.replacements) {
        if (!rep || rep.find == null) continue;
        const needle = rep.isRegex ? new RegExp(rep.find, rep.flags || 'g') : rep.find;
        const updated = decoded.split(needle).join(rep.replace || '');
        if (updated !== decoded) { decoded = updated; changed = true; }
      }
    }
    if (!changed) return null;
    return Buffer.from(decoded, 'utf8').toString('base64');
  }

  // Mode B `response` op (spec 016-04): fulfill a request URL with SUPPLIED bytes
  // — distinct from bodyRewriter's find/replace. A local build step can
  // rebuild a served bundle locally and
  // supplies the rebuilt bytes here; the launcher fulfils exactly those bytes
  // instead of the origin's, so the effect on the live page can be measured.
  //
  // Rule format: { urlPattern, body (utf8 or base64), encoding?:'base64', contentType? }
  // Returns a pure `responseReplacer(event) -> { body(base64), contentType? } | null`
  // that glob-matches the request URL. Purely additive: no `response` op → always
  // null, so existing behaviour is unchanged.
  const responseOps = (Array.isArray(safe.response) ? safe.response : [])
    .filter((op) => op && typeof op === 'object' && typeof op.urlPattern === 'string' && op.urlPattern)
    .map((op) => ({
      regex: globToRegex(op.urlPattern),
      // Normalize to a base64 body (what Fetch.fulfillRequest expects), so a
      // utf8-supplied body and a base64-supplied body are handled identically.
      bodyBase64: op.encoding === 'base64'
        ? String(op.body || '')
        : Buffer.from(String(op.body || ''), 'utf8').toString('base64'),
      contentType: typeof op.contentType === 'string' && op.contentType ? op.contentType : null,
    }));

  function responseReplacer(event) {
    if (responseOps.length === 0) return null;
    const url = (event && event.request && event.request.url) || '';
    for (const op of responseOps) {
      if (op.regex.test(url)) {
        const hit = { body: op.bodyBase64 };
        if (op.contentType) hit.contentType = op.contentType;
        return hit;
      }
    }
    return null;
  }

  return {
    blockPredicate,
    requestHeaderTransformer,
    responseHeaderTransformer,
    preloadLinkHeader,
    bodyRewriter,
    responseReplacer,
    markupMutations: safe.markup || [],
  };
}

// ---------------------------------------------------------------------------
// CDP Fetch handler setup
// ---------------------------------------------------------------------------
async function installFetchInterceptor(client, handlers, interceptMode = 'fulfill') {
  await client.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*', requestStage: 'Request' },
      { urlPattern: '*', requestStage: 'Response' },
    ],
  });

  // ADR-0003 3-arm neutrality probe — arm 1. `passthrough` releases every response
  // with Fetch.continueResponse (NO getResponseBody / fulfillRequest), so the body
  // is never round-tripped through the DevTools protocol. It still pays the
  // Fetch.enable pause, which isolates the pause overhead from the fulfill
  // round-trip cost: (arm-2 identity-fulfill) − (arm-1 passthrough) = round-trip
  // cost. Default `fulfill` is the normal path (arms 2/3) — behaviour is unchanged
  // unless this flag is set.
  const passthrough = interceptMode === 'passthrough';

  client.on('Fetch.requestPaused', async (event) => {
    const { requestId, request, responseStatusCode } = event;
    const isResponseStage = responseStatusCode !== undefined;
    try {
      if (!isResponseStage) {
        if (!passthrough && handlers.blockPredicate(request.url)) {
          await client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
          return;
        }
        const newHeaders = passthrough ? undefined : handlers.requestHeaderTransformer(request);
        await client.send('Fetch.continueRequest', newHeaders ? { requestId, headers: newHeaders } : { requestId });
        return;
      }
      // Response stage.
      if (passthrough) {
        // Arm 1: release without a body round-trip. No patches applied.
        await client.send('Fetch.continueResponse', { requestId });
        return;
      }
      const modHeaders = handlers.responseHeaderTransformer(event) || [];
      const linkVal = handlers.preloadLinkHeader(event);
      if (linkVal) {
        // Remove any existing Link header first so we don't duplicate conflicting values.
        const filtered = modHeaders.filter((h) => h && h.name && h.name.toLowerCase() !== 'link');
        filtered.push({ name: 'Link', value: linkVal });
        modHeaders.length = 0;
        for (const h of filtered) modHeaders.push(h);
      }

      // Mode B `response` op (spec 016-04): if a response op matches this request
      // URL, fulfill with the SUPPLIED bytes (a locally-rebuilt bundle)
      // INSTEAD of fetching + find/replacing the origin body. This is the
      // whole-response fulfill path — we never call Fetch.getResponseBody or the
      // find/replace bodyRewriter for a matched request.
      const responseHit = handlers.responseReplacer ? handlers.responseReplacer(event) : null;
      if (responseHit) {
        if (responseHit.contentType) {
          const filtered = modHeaders.filter((h) => h && h.name && h.name.toLowerCase() !== 'content-type');
          filtered.push({ name: 'Content-Type', value: responseHit.contentType });
          modHeaders.length = 0;
          for (const h of filtered) modHeaders.push(h);
        }
        await client.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: responseStatusCode,
          responseHeaders: modHeaders,
          body: responseHit.body,
        });
        return;
      }

      let body;
      try {
        const r = await client.send('Fetch.getResponseBody', { requestId });
        body = r.body;
      } catch { /* some responses have no body (204/304) */ }

      let modBody = body;
      const rewritten = handlers.bodyRewriter(event, body);
      if (rewritten !== null && rewritten !== undefined) modBody = rewritten;

      const fulfill = { requestId, responseCode: responseStatusCode, responseHeaders: modHeaders };
      if (modBody !== undefined) fulfill.body = modBody;
      await client.send('Fetch.fulfillRequest', fulfill);
    } catch {
      // Fall back to letting the request pass through unmodified.
      try {
        if (isResponseStage) {
          await client.send('Fetch.continueResponse', { requestId });
        } else {
          await client.send('Fetch.continueRequest', { requestId });
        }
      } catch { /* swallow */ }
    }
  });
}

// ---------------------------------------------------------------------------
// Injection: concatenate web-vitals IIFE + measure-cwv.js + collectors.
// ---------------------------------------------------------------------------
function readInjectedScripts() {
  const vendorPath = path.join(__dirname, 'vendor', 'web-vitals.attribution.iife.js');
  const measurePath = path.join(__dirname, 'measure-cwv.js');
  const resourcesPath = path.join(__dirname, 'collect-resources.js');
  const fontsPath = path.join(__dirname, 'collect-fonts.js');
  let vendor = '';
  try {
    vendor = fs.readFileSync(vendorPath, 'utf8');
  } catch {
    process.stderr.write(
      `WARN: ${vendorPath} not found. Run \`npm install\` (postinstall copies the IIFE). ` +
      'CWV metrics will report `web-vitals-not-loaded`.\n',
    );
  }
  const measure = fs.readFileSync(measurePath, 'utf8');
  const resources = fs.readFileSync(resourcesPath, 'utf8');
  const fonts = fs.readFileSync(fontsPath, 'utf8');
  return {
    cwvCombined: vendor + '\n;\n' + measure,
    resources,
    fonts,
  };
}

async function captureDomSnapshot(page, selectors) {
  const cleanSelectors = Array.from(new Set((selectors || []).filter(Boolean)));
  if (cleanSelectors.length === 0) return null;
  return page.evaluate(({ sels, redaction }) => {
    const sensitiveName = new RegExp(redaction.sensitiveName, 'i');
    const redactString = (value) => {
      if (typeof value !== 'string' || value === '') return value;
      return value
        .replace(new RegExp(redaction.email, 'gi'), '[redacted-email]')
        .replace(new RegExp(redaction.longNumber, 'g'), '[redacted-number]')
        .replace(new RegExp(redaction.phone, 'g'), '[redacted-phone]')
        .replace(new RegExp(redaction.bearerOrJwt, 'g'), '[redacted-token]');
    };
    const shouldRedactAttr = (name, value = '') => (
      sensitiveName.test(String(name || '')) || sensitiveName.test(String(value || ''))
    );
    const isSensitiveElement = (el) => {
      if (!el || !el.matches) return false;
      if (el.matches('input, textarea, select, option, [contenteditable="true"], [autocomplete]')) return true;
      return ['id', 'name', 'class', 'aria-label', 'data-field', 'data-name']
        .some((attr) => sensitiveName.test(el.getAttribute(attr) || ''));
    };
    const sanitizeClone = (el) => {
      const clone = el.cloneNode(true);
      const elements = [clone, ...Array.from(clone.querySelectorAll ? clone.querySelectorAll('*') : [])];
      for (const node of elements) {
        for (const attr of Array.from(node.attributes || [])) {
          node.setAttribute(
            attr.name,
            shouldRedactAttr(attr.name, attr.value) ? '[redacted]' : redactString(attr.value),
          );
        }
        if (isSensitiveElement(node)) {
          node.textContent = '[redacted]';
        }
      }
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const textNode of textNodes) {
        textNode.nodeValue = redactString(textNode.nodeValue || '');
      }
      return clone;
    };
    const interestingStyles = [
      'display', 'position', 'visibility', 'opacity', 'overflow',
      'width', 'height', 'minHeight', 'maxHeight',
      'marginTop', 'marginBottom', 'paddingTop', 'paddingBottom',
      'transform', 'transition', 'animation',
    ];
    const summarize = (el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const attrs = {};
      for (const attr of Array.from(el.attributes || [])) {
        attrs[attr.name] = shouldRedactAttr(attr.name, attr.value)
          ? '[redacted]'
          : redactString(attr.value);
      }
      const computed = {};
      for (const name of interestingStyles) computed[name] = cs[name];
      const text = isSensitiveElement(el)
        ? '[redacted]'
        : redactString((el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 240);
      const safeOuter = sanitizeClone(el).outerHTML || '';
      return {
        tagName: el.tagName,
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className : '',
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          bottom: rect.bottom,
          right: rect.right,
        },
        computed,
        attrs,
        text,
        outerHTML: safeOuter.slice(0, 1200),
        parent: el.parentElement ? {
          tagName: el.parentElement.tagName,
          id: el.parentElement.id || '',
          className: typeof el.parentElement.className === 'string' ? el.parentElement.className : '',
        } : null,
      };
    };

    return {
      capturedAt: 'post-settle',
      url: location.href,
      scroll: {
        x: window.scrollX,
        y: window.scrollY,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      selectors: sels,
      nodes: sels.flatMap((selector) => {
        let matches = [];
        try {
          matches = Array.from(document.querySelectorAll(selector));
        } catch (e) {
          return [{ selector, error: e.message, matches: 0, matched: false }];
        }
        if (matches.length === 0) return [{ selector, matches: 0, matched: false }];
        return matches.slice(0, 5).map((el, index) => ({
          selector,
          index,
          matches: matches.length,
          matched: true,
          ...summarize(el),
        }));
      }),
    };
  }, { sels: cleanSelectors, redaction: DOM_SNAPSHOT_REDACTION });
}

// ---------------------------------------------------------------------------
// Per-run execution
// ---------------------------------------------------------------------------
async function executeRun({
  browser,
  url,
  profileName,
  handlers,
  scroll,
  consent,
  cohort,
  interact,
  interactDelay,
  domSnapshotSelectors = [],
  structureSnapshot = false,
  structureSnapshotLimit = DEFAULT_STRUCTURE_SNAPSHOT_LIMIT,
  screenshot,
  injected,
  navTimeout = 60000,
  stealth = false,
  intercept = 'fulfill',
}) {
  const context = await browser.createBrowserContext();
  let page;
  try {
    page = await context.newPage();

    // --stealth: scrub the runtime automation tells (registered before page
    // scripts) + a realistic Accept-Language. The launch-level flags handle the
    // rest; channel:chrome supplies a self-consistent UA so we don't override it.
    if (stealth) await applyStealthPage(page);

    // Device/viewport + network + CPU profile application is shared with the
    // browser analyzers. In stealth mode, mobile profiles keep the mobile
    // viewport but swap to an Android-Chrome UA to match the Chromium runtime.
    await applyProfile(page, { KnownDevices }, profileName, { stealth });

    // Cold-cache fidelity (first-visit cohort): disable the HTTP cache so the
    // measured load is a TRUE cold load. A warm cache (a) masks cold-load cost
    // — warm bundles/images can paint before first paint, hiding LCP/CLS
    // regressions — and (b) lets resources be served from disk WITHOUT hitting
    // the CDP Fetch interceptor, silently no-op'ing block/rewriteBody patches.
    // The returning cohort deliberately keeps the cache warm (its throwaway load
    // warms cache + consent, modelling a repeat visitor), so scope this to the
    // first-visit cohort only.
    if (cohort === 'first-visit') {
      await page.setCacheEnabled(false);
    }

    // The actual viewport this run rendered at — recorded so diagnose/validate
    // output states it. CLS *score* is viewport-relative (see profiles.js), so
    // a desktop CLS is only comparable to another at the same viewport.
    const renderedViewport = page.viewport();

    // CDP Fetch interception.
    const client = await page.target().createCDPSession();
    await installFetchInterceptor(client, handlers, intercept);

    // Script injections (BEFORE any page script).
    await page.evaluateOnNewDocument(injected.cwvCombined);
    await page.evaluateOnNewDocument(injected.resources);
    await page.evaluateOnNewDocument(injected.fonts);
    if (handlers.markupMutations && handlers.markupMutations.length > 0) {
      await page.evaluateOnNewDocument(buildMarkupMutationScript(handlers.markupMutations));
    }

    // Returning-visitor cohort: do a throwaway first load, accept consent, then
    // measure a reload. Consent persists in this context's cookies/storage (the
    // workbench launcher does not clear cookies between navigations within a run),
    // so the measured reload has no banner — approximating a returning user. The
    // throwaway document's metrics are discarded (the reload is a fresh document;
    // web-vitals + shift observers reset per document).
    if (cohort === 'returning') {
      try {
        await page.goto(url, { waitUntil: 'load', timeout: navTimeout });
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
        const matched = await dismissConsent(page, CONSENT_ACCEPT_SELECTORS);
        if (matched) process.stderr.write(`cohort=returning: pre-accepted consent via ${matched}\n`);
        await new Promise((r) => setTimeout(r, 800)); // let the CMP persist consent
      } catch (e) {
        process.stderr.write(`WARN: returning-cohort pre-accept failed: ${e.message}\n`);
      }
    }

    // Navigate (the measured load; a reload for the returning cohort).
    await page.goto(url, { waitUntil: 'load', timeout: navTimeout });

    // Wait for network to settle, but cap it. This window also lets a late
    // consent banner appear and shift — that entrance shift is captured by the
    // buffered observers before any consent dismissal below.
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

    const structureSnapshotPreScroll = structureSnapshot
      ? await page.evaluate(captureEdsStructureSnapshotInPage, {
        limit: structureSnapshotLimit,
        phase: 'pre-scroll',
      })
      : null;

    // Field-faithful mode: dismiss consent (best-effort), then scroll to bottom
    // settling to quiescence so post-load CLS (scroll-lazy ads, banners) is
    // captured by web-vitals' CLS observer.
    let scrollDiag = null;
    if (scroll) {
      if (consent !== 'none') {
        const matched = await dismissConsent(page, CONSENT_ACCEPT_SELECTORS);
        if (matched) process.stderr.write(`scroll-mode: dismissed consent via ${matched}\n`);
      }
      try {
        scrollDiag = await page.evaluate(scrollAndSettleInPage, DEFAULT_SCROLL_OPTS);
      } catch (e) {
        process.stderr.write(`WARN: scroll routine failed: ${e.message}\n`);
      }
      // Network-quiescence backstop after lazy content triggered by scrolling.
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }).catch(() => {});
    }

    // Optional interaction for INP.
    if (interact) {
      try {
        await page.click(interact);
      } catch (e) {
        process.stderr.write(`WARN: click("${interact}") failed: ${e.message}\n`);
      }
      await new Promise((r) => setTimeout(r, interactDelay));
    }

    // Force LCP/CLS finalization via visibilitychange -> hidden.
    await page.evaluate(() => {
      try {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      } catch { /* noop */ }
    });
    await new Promise((r) => setTimeout(r, 500));

    const cwv = await page.evaluate(() => (window.__cwv_snapshot ? window.__cwv_snapshot() : null));
    const resources = await page.evaluate(() => (window.__resources_snapshot ? window.__resources_snapshot() : null));
    const fonts = await page.evaluate(() => (window.__fonts_snapshot ? window.__fonts_snapshot() : null));
    const domSnapshot = await captureDomSnapshot(page, domSnapshotSelectors);
    const structureSnapshotFinal = structureSnapshot
      ? await page.evaluate(captureEdsStructureSnapshotInPage, {
        limit: structureSnapshotLimit,
        phase: scroll ? 'post-scroll' : 'final',
      })
      : null;
    const structureSnapshotResult = structureSnapshot
      ? {
        ...(structureSnapshotPreScroll || structureSnapshotFinal),
        phase: 'pre-scroll',
        preScroll: structureSnapshotPreScroll,
        final: structureSnapshotFinal,
      }
      : null;

    // In scroll mode, fold the per-shift sources into ranked shifting elements
    // so the dominant CLS culprit (e.g. a consent banner) is surfaced directly.
    if (scroll && cwv && cwv.cls && Array.isArray(cwv.cls.shifts)) {
      const agg = aggregateClsByNode(cwv.cls.shifts);
      cwv.cls.shiftSources = agg.topShiftingElements;
      cwv.cls.shiftSummary = {
        naiveSumExclRecentInput: agg.totalShiftValue,
        // Session-windowed CLS from the same entries — cross-check vs cls.value
        // (web-vitals). A sharp divergence flags a web-vitals finalize regression.
        windowedFromShifts: windowedCls(cwv.cls.shifts),
        shiftCount: agg.shiftCount,
      };
    }

    if (screenshot) {
      try {
        fs.mkdirSync(path.dirname(path.resolve(screenshot)), { recursive: true });
        await page.screenshot({ path: screenshot, fullPage: true });
      } catch (e) {
        process.stderr.write(`WARN: screenshot failed: ${e.message}\n`);
      }
    }

    const result = { cwv, resources, fonts, viewport: renderedViewport, timestamp: new Date().toISOString() };
    if (domSnapshot) result.domSnapshot = domSnapshot;
    if (structureSnapshotResult) result.structureSnapshot = structureSnapshotResult;
    if (scrollDiag) result.scroll = scrollDiag;
    if (domSnapshot) result.domSnapshot = domSnapshot;
    return result;
  } finally {
    try { await context.close(); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (!args.url) {
    process.stderr.write('Error: --url is required.\n' + HELP);
    process.exit(2);
  }
  const profile = PROFILES[args.profile];
  if (!profile) {
    process.stderr.write(`Error: unknown profile "${args.profile}".\n` + HELP);
    process.exit(2);
  }
  if (args.consent && args.consent !== 'dismiss' && args.consent !== 'none') {
    process.stderr.write(`Error: --consent must be "dismiss" or "none" (got "${args.consent}").\n` + HELP);
    process.exit(2);
  }
  if (args.cohort !== 'first-visit' && args.cohort !== 'returning') {
    process.stderr.write(`Error: --cohort must be "first-visit" or "returning" (got "${args.cohort}").\n` + HELP);
    process.exit(2);
  }
  if (args.intercept && args.intercept !== 'fulfill' && args.intercept !== 'passthrough') {
    process.stderr.write(`Error: --intercept must be "fulfill" or "passthrough" (got "${args.intercept}").\n` + HELP);
    process.exit(2);
  }

  // ADR-0014 preflight gate (spec 014-01): opt-in via --preflight-profile so
  // repeated in-session calls (e.g. cwv-orchestrate's racing loop) don't pay
  // doctor's subprocess-spawning checks on every launcher.js invocation. No
  // flag => true no-op (checkPreflight short-circuits before calling doctor).
  // This is defense-in-depth — the AUTHORITATIVE Step-0 gate is the standalone
  // `node .agents/scripts/preflight.js --profile <name>` cwv-orchestrate runs
  // before ever invoking launcher.js (see cwv-orchestrate.md Step 0).
  let preflight;
  try {
    preflight = checkPreflight({ profile: args.preflightProfile, skip: args.skipPreflight });
  } catch (err) {
    // runDoctor throws on an unknown --preflight-profile; surface it as a clean
    // usage error (exit 2), consistent with launcher's other bad-arg handling.
    process.stderr.write(`Error: ${err.message}\n` + HELP);
    process.exit(2);
  }
  const preflightGate = formatPreflightGate(preflight);
  if (preflightGate.text) {
    process.stderr.write(preflightGate.text);
  }
  if (preflightGate.exitCode !== 0) {
    process.exit(preflightGate.exitCode);
  }

  // Default consent handling: dismiss in scroll mode, none otherwise.
  const consent = args.consent || (args.scroll ? 'dismiss' : 'none');

  const bundle = args.patches ? loadPatchBundle(args.patches) : {};
  // Merge --block globs into the bundle's block list (CLI ergonomics over the
  // existing patch-bundle block capability). Useful for stubbing ad/3p noise
  // that wrecks measurement reliability on heavy pages.
  if (args.block && args.block.length) {
    bundle.block = [...(Array.isArray(bundle.block) ? bundle.block : []), ...args.block];
  }
  const handlers = composePatchHandlers(bundle);
  const injected = readInjectedScripts();

  // Run plan (ROADMAP V2): --runs is the success floor, --max-runs the adaptive
  // cap. A failed run is skipped/retried (not fatal); the loop attempts up to
  // attemptCap times to reach targetSuccesses SUCCESSFUL runs, and the batch is
  // "usable" (exit 0) once it reaches requiredSuccesses (the --min-samples floor).
  const plan = computeRunPlan({
    runs: args.runs,
    maxRuns: args.maxRuns,
    minSamples: args.minSamples,
    maxFailures: args.maxFailures,
  });
  const { floorRuns, capRuns, adaptive, targetSuccesses, attemptCap, maxFailures, requiredSuccesses } = plan;
  const reliabilityMetrics = args.reliabilityMetrics
    || ['LCP', 'CLS', 'FCP', 'TTFB'].concat(args.interact ? ['INP'] : []);

  const output = {
    url: args.url,
    profile: args.profile,
    cohort: args.cohort,
    // The actual rendered viewport (spec 003-06), filled from the first
    // successful run below. null until measured (or if every run failed).
    viewport: null,
    runs: [],
  };
  if (isNonEmptyPatchBundle(bundle)) {
    output.appliedPatches = summarizePatchBundle(bundle);
    // Spec 016-02: declare the treatment in ASV Mode A/B vocabulary alongside
    // the existing summary. Re-labeling only — no measurement/interception
    // change (ADR-0016 §3). 016-06's adapter reads `modes` without translation.
    output.appliedPatches.modes = describePatchModes(bundle);
  }

  let browser;
  let exitCode = 0;
  try {
    // --stealth: headful real Chrome with automation tells scrubbed, to pass
    // Cloudflare/anti-bot managed challenges (the pharma case-family). Verified the only
    // combo that works — headless (incl. headless:'new') gets a 403 challenge stub.
    // See references/topics/anti-bot-measurement.md.
    browser = await puppeteer.launch(buildLaunchOptions(args.stealth));
    const multiRun = capRuns > 1;
    let attempts = 0;
    let failures = 0;
    const failureLog = [];
    // Attempt runs until we have enough successful ones or exhaust the budget.
    // A failed run (e.g. a nav timeout on a flaky slow target) is skipped/retried
    // rather than aborting the whole batch (ROADMAP V2).
    while (attempts < attemptCap && output.runs.length < targetSuccesses) {
      attempts += 1;
      const runIndex = output.runs.length; // sequential index among SUCCESSFUL runs
      const runScreenshot = args.screenshot && multiRun
        ? args.screenshot.replace(/(\.[^.]+)$/, `-run${runIndex + 1}$1`)
        : args.screenshot;
      try {
        const result = await executeRun({
          browser,
          url: args.url,
          profileName: args.profile,
          handlers,
          scroll: args.scroll,
          consent,
          cohort: args.cohort,
          interact: args.interact,
          interactDelay: args.interactDelay,
          domSnapshotSelectors: args.domSnapshotSelectors,
          structureSnapshot: args.structureSnapshot,
          structureSnapshotLimit: args.structureSnapshotLimit,
          screenshot: runIndex === 0 || multiRun ? runScreenshot : null,
          injected,
          navTimeout: args.navTimeout,
          stealth: args.stealth,
          intercept: args.intercept || 'fulfill',
        });
        output.runs.push(result);
      } catch (err) {
        failures += 1;
        failureLog.push({ attempt: attempts, error: err.message, phase: 'execute' });
        const giveUp = failures > maxFailures;
        process.stderr.write(JSON.stringify({
          error: err.message, attempt: attempts, failures, phase: 'execute',
          action: giveUp ? 'give-up' : 'skip-retry',
        }) + '\n');
        if (giveUp) {
          process.stderr.write(`launcher: ${failures} failed run(s) > --max-failures ${maxFailures}; stopping batch\n`);
          break;
        }
        continue; // skip this attempt; the next iteration retries a fresh run
      }
      // Adaptive early-exit: once past the floor of SUCCESSFUL runs, stop as soon
      // as the reliability metrics have stabilized.
      if (adaptive && output.runs.length >= floorRuns) {
        const q = assessLauncherOutput(output, reliabilityMetrics, { minSamples: args.minSamples });
        if (q.allReliable) {
          process.stderr.write(`adaptive: reliable after ${output.runs.length} run(s)\n`);
          break;
        }
        if (output.runs.length >= capRuns) {
          process.stderr.write(`adaptive: hit --max-runs ${capRuns} without full reliability\n`);
        }
      }
    }

    // Record the actual rendered viewport (spec 003-06) so cwv-diagnose /
    // cwv-validate output states it. Read from the first successful run rather
    // than the profile so it reflects what really rendered (incl. mobile's
    // device viewport). CLS *score* is viewport-relative — see profiles.js.
    if (output.runs.length > 0 && output.runs[0].viewport) {
      output.viewport = output.runs[0].viewport;
    }

    // Batch outcome: usable (exit 0) once enough successful runs accrued; a
    // genuine shortfall below the --min-samples floor is exit 1 — but a single
    // flaky run no longer fails the batch.
    exitCode = decideLauncherExit(output.runs.length, plan);
    if (exitCode !== 0) {
      process.stderr.write(`launcher: only ${output.runs.length} successful run(s) < required ${requiredSuccesses} (--min-samples ${plan.minSamples}); measurement unusable\n`);
    }
    if (failures > 0) {
      output.runsFailed = failures;
      output.attempts = attempts;
      output.failures = failureLog;
    }

    // Emit a measurement-quality block for any multi-run / adaptive measurement
    // (or whenever a run failed) so downstream (and humans) can see whether the
    // numbers are trustworthy before the oracle runs. Additive — absent for a
    // clean single non-adaptive run.
    if (capRuns > 1 || adaptive || failures > 0) {
      const q = assessLauncherOutput(output, reliabilityMetrics, { minSamples: args.minSamples });
      output.measurementQuality = {
        reliable: q.allReliable,
        runsRequested: capRuns,
        runsExecuted: output.runs.length,
        runsFailed: failures,
        attempts,
        floorRuns,
        capRuns,
        requiredSuccesses,
        minSamples: args.minSamples,
        metrics: reliabilityMetrics,
        perMetric: q.perMetric,
      };
    }
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message, phase: 'launch' }) + '\n');
    exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch { /* noop */ } }
  }

  const json = JSON.stringify(output, null, 2);
  if (args.output) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
      fs.writeFileSync(args.output, json);
    } catch (err) {
      process.stderr.write(JSON.stringify({ error: err.message, phase: 'write-output' }) + '\n');
      exitCode = 1;
    }
  } else {
    process.stdout.write(json + '\n');
  }
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ error: err && err.message || String(err), phase: 'main' }) + '\n');
    process.exit(1);
  });
}

export {
  PROFILES,
  parseArgs,
  computeRunPlan,
  decideLauncherExit,
  DEFAULT_STRUCTURE_SNAPSHOT_LIMIT,
  normalizeDomSnapshotSelectors,
  redactDomSnapshotString,
  shouldRedactDomSnapshotAttribute,
  captureDomSnapshot,
  readInjectedScripts,
  isNonEmptyPatchBundle,
  summarizePatchBundle,
  normalizeEdsStructureSnapshotOptions,
  captureEdsStructureSnapshotInPage,
  composePatchHandlers,
  installFetchInterceptor,
  executeRun,
};
