#!/usr/bin/env node
/**
 * Image analyzer — detects image-related CWV waste.
 *
 * Heuristics (see .agents/references/topics/image-optimization.md):
 *   1. Oversized image (pixel waste)
 *   2. Wrong format for opportunity (JPEG/PNG where WebP/AVIF wins)
 *   3. Missing srcset on responsive image
 *   4. LCP image without fetchpriority=high
 *   5. Above-the-fold image with loading="lazy"
 *   6. Below-the-fold images without loading="lazy" (aggregated)
 *
 * Emits Findings conforming to .agents/references/topics/finding-schema.md.
 * Every emitted Finding is validated via validateFinding().
 *
 * CLI:
 *   node image-analysis.js --url <URL> [--profile <name>] [--output <path>]
 */


import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import {
  SCHEMA_VERSION,
  MIN_IMPACT,
  SOURCE_TIERS,
  deriveSeverity,
  validateFinding,
} from '../finding-schema.js';

// Throttling profile table is shared with launcher.js — see ../profiles.js.
import { PROFILES, applyProfile } from '../profiles.js';
import { buildLaunchOptions, applyStealthPage } from '../launch-opts.js';

// Bytes-per-KB-to-ms proxy for slow-4G (≈160 KB/s effective => ~6.25 ms/KB
// transfer, but TCP/CW/TLS overhead tilts toward 10 ms/KB for practical
// waste estimates on small-to-medium assets). See image-optimization.md.
const MS_PER_KB_SLOW4G = 10;
const WEBP_AVIF_AVG_SAVINGS = 0.35; // ~35% bytes saved vs JPEG/PNG at parity
const OVERSIZE_BUFFER = 1.5;        // 50% slack before we call it oversized
const MIN_LARGE_IMAGE_BYTES = 50 * 1024;   // wrong-format gate
const MIN_RESPONSIVE_BYTES = 10 * 1024;    // missing-srcset gate

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Guard — clamp confidence to the source-tier cap defined in finding-schema.js.
 * @param {string} source
 * @param {number} desired
 * @returns {number}
 */
function capConfidence(source, desired) {
  const tier = SOURCE_TIERS[source];
  if (!tier) return desired;
  return Math.min(desired, tier.maxConfidence);
}

/**
 * Estimate optimal bytes for an oversized image if it were resized to the
 * rendered dimensions (accounting for DPR). Assumes bytes scale roughly
 * linearly with pixel count for a given format/quality.
 * @param {number} actualBytes
 * @param {number} naturalPixels
 * @param {number} renderedPixelsWithDpr
 * @returns {number}
 */
function estimateOptimalBytes(actualBytes, naturalPixels, renderedPixelsWithDpr) {
  if (naturalPixels <= 0) return actualBytes;
  const ratio = Math.min(1, renderedPixelsWithDpr / naturalPixels);
  return Math.max(1024, Math.round(actualBytes * ratio));
}

/**
 * Produce a stable evidence entry for an image resource with transfer size.
 * @param {{url: string, bytes: number, contentType?: string, mimeFromExt?: string}} img
 * @returns {{kind: string, data: object}}
 */
function resourceTimingEvidence(img) {
  return {
    kind: 'resource-timing',
    data: {
      url: img.url,
      transferSize: img.bytes || 0,
      type: 'img',
      contentType: img.contentType || img.mimeFromExt || null,
    },
  };
}

/**
 * Suppress a finding below MIN_ACTIONABLE_IMPACT by flipping status to
 * rejected. Preserves everything else so the caller can see WHY it was
 * rejected.
 * @param {object} finding
 * @returns {object}
 */
function applyImpactGate(finding) {
  const ir = finding.impactReduction;
  if (!ir) return finding;
  const floor = MIN_IMPACT[ir.metric];
  if (!floor) return finding;
  const mag = Math.abs(typeof ir.valueMs === 'number' ? ir.valueMs : (ir.score || 0));
  if (mag < floor.delta) {
    return { ...finding, status: 'rejected', severity: 'low' };
  }
  return finding;
}

// ---------------------------------------------------------------------------
// LCP-candidate detection
// ---------------------------------------------------------------------------

/**
 * Pick the largest above-the-fold, visible image as the LCP candidate.
 * Heuristic only — the real LCP element can only be known at render time via
 * PerformanceObserver. Good-enough for static DOM analysis.
 * @param {Array} images
 * @returns {object|null}
 */
function pickLcpCandidate(images) {
  let best = null;
  let bestArea = 0;
  for (const img of images) {
    if (!img.aboveFold || !img.displayed) continue;
    const area = (img.renderedWidth || 0) * (img.renderedHeight || 0);
    if (area > bestArea) {
      bestArea = area;
      best = img;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Heuristics — pure functions over an image snapshot array.
// Each returns an array of findings (possibly empty). Findings are gated
// and validated by the top-level analyze() wrapper.
// ---------------------------------------------------------------------------

function ctx(url) {
  return { url, timestamp: new Date().toISOString() };
}

/** Heuristic 1: oversized image */
function detectOversized(images, pageUrl, idxBase) {
  const out = [];
  let n = idxBase;
  for (const img of images) {
    if (!img.displayed || !img.naturalWidth || !img.naturalHeight) continue;
    if (!img.renderedWidth || !img.renderedHeight) continue;

    const dpr = img.dpr || 1;
    const naturalPixels = img.naturalWidth * img.naturalHeight;
    const renderedPixelsDpr = img.renderedWidth * img.renderedHeight * dpr * dpr;
    if (naturalPixels <= renderedPixelsDpr * OVERSIZE_BUFFER) continue;

    const bytes = img.bytes || 0;
    const optimalBytes = estimateOptimalBytes(bytes, naturalPixels, renderedPixelsDpr);
    const wastedKb = Math.max(0, (bytes - optimalBytes) / 1024);
    const valueMs = Math.round(wastedKb * MS_PER_KB_SLOW4G);

    const metrics = img.aboveFold ? ['LCP'] : ['LCP', 'SI'];
    const source = bytes > 0 ? 'har' : 'html';
    const confidence = capConfidence(source, bytes > 0 ? 0.85 : 0.70);

    const evidence = [
      {
        kind: 'rule-violation',
        data: {
          ruleId: 'image-oversized',
          match: img.url,
          context: {
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            renderedWidth: img.renderedWidth,
            renderedHeight: img.renderedHeight,
            dpr,
            aboveFold: !!img.aboveFold,
          },
        },
      },
    ];
    if (bytes > 0) evidence.push(resourceTimingEvidence(img));

    const finding = applyImpactGate({
      schemaVersion: SCHEMA_VERSION,
      id: `img-oversized-${++n}`,
      ...ctx(pageUrl),
      skill: 'cwv-diagnose',
      source,
      metric: metrics,
      type: 'waste',
      severity: deriveSeverity({ metric: 'LCP', valueMs }),
      rootCause: img.aboveFold,
      cause: `Image served at ${img.naturalWidth}x${img.naturalHeight} but rendered at ${img.renderedWidth}x${img.renderedHeight} (DPR ${dpr}); ${Math.round(wastedKb)} KB of pixel data is unused.`,
      evidence,
      recommendation: `Resize and re-encode to ~${Math.ceil(img.renderedWidth * dpr)}x${Math.ceil(img.renderedHeight * dpr)}, or add srcset with appropriately-sized variants.`,
      confidence,
      impactReduction: { metric: 'LCP', valueMs },
      status: 'proposed',
    });
    out.push(finding);
  }
  return out;
}

/** Heuristic 2: wrong format (JPEG/PNG → WebP/AVIF) */
function detectWrongFormat(images, pageUrl, idxBase) {
  const out = [];
  let n = idxBase;
  for (const img of images) {
    const ct = (img.contentType || '').toLowerCase();
    const bytes = img.bytes || 0;
    const isLegacy = ct.includes('image/jpeg') || ct.includes('image/png');
    if (!isLegacy || bytes < MIN_LARGE_IMAGE_BYTES) continue;

    const savedKb = (bytes * WEBP_AVIF_AVG_SAVINGS) / 1024;
    const valueMs = Math.round(savedKb * MS_PER_KB_SLOW4G);

    const finding = applyImpactGate({
      schemaVersion: SCHEMA_VERSION,
      id: `img-format-${++n}`,
      ...ctx(pageUrl),
      skill: 'cwv-diagnose',
      source: 'har',
      metric: img.aboveFold ? ['LCP'] : ['LCP', 'SI'],
      type: 'opportunity',
      severity: deriveSeverity({ metric: 'LCP', valueMs }),
      rootCause: false,
      cause: `Image served as ${ct} at ${Math.round(bytes / 1024)} KB; WebP/AVIF at same perceived quality saves ~${Math.round(WEBP_AVIF_AVG_SAVINGS * 100)}%.`,
      evidence: [
        {
          kind: 'rule-violation',
          data: { ruleId: 'image-legacy-format', match: img.url, context: { contentType: ct } },
        },
        resourceTimingEvidence(img),
      ],
      recommendation: `Re-encode as AVIF (preferred) or WebP. Use a <picture> element with legacy fallback if you need to support pre-2021 browsers.`,
      confidence: capConfidence('har', 0.80),
      impactReduction: { metric: 'LCP', valueMs },
      status: 'proposed',
    });
    out.push(finding);
  }
  return out;
}

/** Heuristic 3: missing srcset on responsive images */
function detectMissingSrcset(images, pageUrl, idxBase) {
  const out = [];
  let n = idxBase;
  for (const img of images) {
    if (!img.displayed) continue;
    if (img.srcset && img.srcset.trim().length > 0) continue;
    if (!img.renderedWidth || !img.naturalWidth) continue;
    if (img.renderedWidth === img.naturalWidth) continue;
    const bytes = img.bytes || 0;
    if (bytes > 0 && bytes < MIN_RESPONSIVE_BYTES) continue;

    const assumedKb = Math.max(MIN_RESPONSIVE_BYTES, bytes) / 1024;
    const savedKb = assumedKb * 0.3; // conservative: ~30% savings via right-sized variants
    const valueMs = Math.round(savedKb * MS_PER_KB_SLOW4G);

    const finding = applyImpactGate({
      schemaVersion: SCHEMA_VERSION,
      id: `img-srcset-${++n}`,
      ...ctx(pageUrl),
      skill: 'cwv-diagnose',
      source: bytes > 0 ? 'har' : 'html',
      metric: ['LCP'],
      type: 'opportunity',
      severity: deriveSeverity({ metric: 'LCP', valueMs }),
      rootCause: false,
      cause: `<img> has no srcset but is CSS-sized (natural ${img.naturalWidth}px vs rendered ${img.renderedWidth}px). Low-DPR / narrow viewports download full-size asset.`,
      evidence: [
        {
          kind: 'rule-violation',
          data: {
            ruleId: 'image-missing-srcset',
            match: img.url,
            context: {
              naturalWidth: img.naturalWidth,
              renderedWidth: img.renderedWidth,
            },
          },
        },
      ].concat(bytes > 0 ? [resourceTimingEvidence(img)] : []),
      recommendation: `Add srcset with 1x/2x/3x variants and a sizes attribute that matches your CSS layout width.`,
      confidence: capConfidence(bytes > 0 ? 'har' : 'html', 0.70),
      impactReduction: { metric: 'LCP', valueMs },
      status: 'proposed',
    });
    out.push(finding);
  }
  return out;
}

/** Heuristic 4: LCP image without fetchpriority=high */
function detectLcpFetchpriority(images, pageUrl, idxBase) {
  const lcp = pickLcpCandidate(images);
  if (!lcp) return [];
  if ((lcp.fetchpriority || '').toLowerCase() === 'high') return [];

  const valueMs = 400; // mid-point of the 300-500ms typical range
  const finding = applyImpactGate({
    schemaVersion: SCHEMA_VERSION,
    id: `img-lcp-fetchpriority-${idxBase + 1}`,
    ...ctx(pageUrl),
    skill: 'cwv-diagnose',
    source: 'html',
    metric: ['LCP'],
    type: 'opportunity',
    severity: 'high',
    rootCause: true,
    cause: `Largest above-the-fold image lacks fetchpriority="high"; browser defers it behind other resources.`,
    evidence: [
      {
        kind: 'rule-violation',
        data: {
          ruleId: 'image-lcp-no-fetchpriority',
          match: lcp.url,
          context: { renderedWidth: lcp.renderedWidth, renderedHeight: lcp.renderedHeight },
        },
      },
    ],
    recommendation: `Add fetchpriority="high" to the LCP <img> to prioritize its fetch over sub-resources.`,
    patches: {
      markup: [
        { selector: `img[src='${lcp.url}']`, attrs: { fetchpriority: 'high' } },
      ],
    },
    confidence: capConfidence('html', 0.75),
    impactReduction: { metric: 'LCP', valueMs },
    status: 'proposed',
  });
  return [finding];
}

/** Heuristic 5: above-the-fold image with loading="lazy" */
function detectAboveFoldLazy(images, pageUrl, idxBase) {
  const out = [];
  let n = idxBase;
  for (const img of images) {
    if (!img.aboveFold || !img.displayed) continue;
    if ((img.loading || '').toLowerCase() !== 'lazy') continue;

    const valueMs = 500;
    const finding = applyImpactGate({
      schemaVersion: SCHEMA_VERSION,
      id: `img-af-lazy-${++n}`,
      ...ctx(pageUrl),
      skill: 'cwv-diagnose',
      source: 'html',
      metric: ['LCP'],
      type: 'bottleneck',
      severity: 'high',
      rootCause: true,
      cause: `Above-the-fold <img> has loading="lazy", which defers its discovery until layout and delays LCP.`,
      evidence: [
        {
          kind: 'rule-violation',
          data: {
            ruleId: 'image-above-fold-lazy',
            match: img.url,
            context: { aboveFold: true, loading: 'lazy' },
          },
        },
      ],
      recommendation: `Remove loading="lazy" from above-the-fold images. Only use it on images below the initial viewport.`,
      patches: {
        markup: [
          { selector: `img[src='${img.url}']`, attrs: { loading: null } },
        ],
      },
      confidence: capConfidence('html', 0.75),
      impactReduction: { metric: 'LCP', valueMs },
      status: 'proposed',
    });
    out.push(finding);
  }
  return out;
}

/** Heuristic 6: below-the-fold images without loading="lazy" (aggregated) */
function detectBelowFoldEager(images, pageUrl, idxBase) {
  const offenders = [];
  let totalBytes = 0;
  for (const img of images) {
    if (img.aboveFold || !img.displayed) continue;
    if ((img.loading || '').toLowerCase() === 'lazy') continue;
    offenders.push(img);
    totalBytes += img.bytes || 0;
  }
  if (offenders.length === 0) return [];

  const valueMs = Math.round((totalBytes / 1024) * MS_PER_KB_SLOW4G);
  const source = totalBytes > 0 ? 'har' : 'html';
  const finding = applyImpactGate({
    schemaVersion: SCHEMA_VERSION,
    id: `img-bf-eager-${idxBase + 1}`,
    ...ctx(pageUrl),
    skill: 'cwv-diagnose',
    source,
    metric: ['LCP', 'SI'],
    type: 'waste',
    severity: deriveSeverity({ metric: 'LCP', valueMs }),
    rootCause: false,
    cause: `${offenders.length} below-the-fold image(s) load eagerly, competing with critical above-the-fold resources.`,
    evidence: [
      {
        kind: 'rule-violation',
        data: {
          ruleId: 'image-below-fold-not-lazy',
          match: offenders.map((o) => o.url),
          context: { count: offenders.length, totalKB: Math.round(totalBytes / 1024) },
        },
      },
    ],
    recommendation: `Add loading="lazy" to all below-the-fold <img> tags. Verify none are within the initial viewport on common breakpoints.`,
    patches: {
      markup: offenders.map((o) => ({
        selector: `img[src='${o.url}']`,
        attrs: { loading: 'lazy' },
      })),
    },
    confidence: capConfidence(source, 0.75),
    impactReduction: { metric: 'LCP', valueMs },
    status: 'proposed',
  });
  return [finding];
}

// ---------------------------------------------------------------------------
// Public pure-function entry: classify a set of image snapshots into findings.
// Exported separately so tests can exercise heuristics without a browser.
// ---------------------------------------------------------------------------

/**
 * Run all heuristics over an image snapshot array and return validated findings.
 * @param {string} pageUrl
 * @param {Array} images
 * @returns {{findings: Array, rejected: Array, invalid: Array}}
 */
function classifyImages(pageUrl, images) {
  const all = [
    ...detectOversized(images, pageUrl, 0),
    ...detectWrongFormat(images, pageUrl, 0),
    ...detectMissingSrcset(images, pageUrl, 0),
    ...detectLcpFetchpriority(images, pageUrl, 0),
    ...detectAboveFoldLazy(images, pageUrl, 0),
    ...detectBelowFoldEager(images, pageUrl, 0),
  ];

  const findings = [];
  const rejected = [];
  const invalid = [];
  for (const f of all) {
    const res = validateFinding(f);
    if (!res.valid) {
      invalid.push({ finding: f, errors: res.errors });
      continue;
    }
    if (f.status === 'rejected') rejected.push(f);
    else findings.push(f);
  }
  return { findings, rejected, invalid };
}

// ---------------------------------------------------------------------------
// Browser collection (Puppeteer) — only loaded when needed
// ---------------------------------------------------------------------------

/**
 * Collect DOM + network image data by navigating a headless Chromium.
 * Returns the same snapshot shape that classifyImages() expects.
 * @param {string} url
 * @param {string} profileName
 * @returns {Promise<Array>}
 */
async function collectImages(url, profileName, { stealth = false } = {}) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown profile: ${profileName}`);
  let puppeteer;
  let knownDevices;
  try {
    const mod = await import('puppeteer');
    puppeteer = mod.default;
    // The device table is the NAMED export (Puppeteer 22's default export has
    // no `.KnownDevices`); capture it for resolveMobileEmulation below.
    knownDevices = mod.KnownDevices;
  } catch {
    throw new Error('puppeteer not installed; run `npm install`');
  }

  const browser = await puppeteer.launch(buildLaunchOptions(stealth));
  const headersByUrl = new Map();
  try {
    const page = await browser.newPage();

    if (stealth) await applyStealthPage(page);
    await applyProfile(page, { KnownDevices: knownDevices }, profileName, { stealth });

    page.on('response', async (resp) => {
      try {
        const headers = resp.headers();
        const ct = headers['content-type'] || '';
        if (!ct.startsWith('image/')) return;
        const cl = parseInt(headers['content-length'], 10);
        let bytes = Number.isFinite(cl) ? cl : 0;
        if (!bytes) {
          try { const buf = await resp.buffer(); bytes = buf ? buf.length : 0; } catch { /* noop */ }
        }
        headersByUrl.set(resp.url(), { contentType: ct.split(';')[0].trim(), bytes });
      } catch { /* noop */ }
    });

    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

    const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
    const domImages = await page.evaluate(() => {
      const vh = window.innerHeight || 0;
      return Array.from(document.images).map((img) => {
        const r = img.getBoundingClientRect();
        const style = window.getComputedStyle(img);
        return {
          url: img.currentSrc || img.src,
          src: img.getAttribute('src') || '',
          srcset: img.getAttribute('srcset') || '',
          sizes: img.getAttribute('sizes') || '',
          loading: img.getAttribute('loading') || '',
          decoding: img.getAttribute('decoding') || '',
          fetchpriority: img.getAttribute('fetchpriority') || '',
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          renderedWidth: Math.round(r.width),
          renderedHeight: Math.round(r.height),
          top: r.top,
          aboveFold: r.top < vh && r.top + r.height > 0,
          displayed: style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0,
        };
      });
    });

    const out = domImages.map((img) => {
      const net = headersByUrl.get(img.url) || {};
      return { ...img, dpr, contentType: net.contentType || '', bytes: net.bytes || 0 };
    });
    return out;
  } finally {
    try { await browser.close(); } catch { /* noop */ }
  }
}

/**
 * Top-level analyzer entry: collect then classify.
 * @param {{url: string, profile?: string}} args
 */
async function analyzeImages({ url, profile = 'mobile-slow4g-4xcpu', stealth = false }) {
  const images = await collectImages(url, profile, { stealth });
  const { findings, rejected, invalid } = classifyImages(url, images);
  return {
    findings,
    summary: {
      imagesInspected: images.length,
      findingsEmitted: findings.length,
      findingsRejected: rejected.length,
      validationErrors: invalid.length,
    },
    raw: { images, rejected, invalid },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { url: null, profile: 'mobile-slow4g-4xcpu', output: null, stealth: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--help': case '-h': args.help = true; break;
      case '--url': args.url = next(); break;
      case '--profile': args.profile = next(); break;
      case '--output': args.output = next(); break;
      case '--stealth': args.stealth = true; break;
      default:
        if (a && a.startsWith('--')) {
          process.stderr.write(`Unknown flag: ${a}\n`);
          process.exit(2);
        }
    }
  }
  return args;
}

const HELP = `
image-analysis — detect image-related CWV waste.

Usage: node image-analysis.js --url <URL> [flags]

Flags:
  --url <url>         Target page URL (required)
  --profile <name>    Throttling profile (default: mobile-slow4g-4xcpu)
                      Options: mobile-slow4g-4xcpu | desktop-cable-1xcpu |
                      desktop-slow-1xcpu | no-throttle
  --stealth           Launch headful real Chrome with automation tells scrubbed
                      for Cloudflare / anti-bot managed challenges.
  --output <path>     Write JSON output to file (default: stdout)
  --help              Print this help and exit 0
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  if (!args.url) { process.stderr.write('Error: --url is required.\n' + HELP); process.exit(2); }

  try {
    const result = await analyzeImages({ url: args.url, profile: args.profile, stealth: args.stealth });
    // Emit a schema-valid finding envelope (finding-schema.js validateEnvelope),
    // matching coverage.js / html-parse.js so the diagnose flow can consume it directly.
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      skill: 'cwv-diagnose',
      url: args.url,
      timestamp: new Date().toISOString(),
      summary: result.summary,
      findings: result.findings,
      raw: result.raw,
    };
    const json = JSON.stringify(envelope, null, 2);
    if (args.output) {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
      fs.writeFileSync(args.output, json);
    } else {
      process.stdout.write(json + '\n');
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err && err.message || String(err), phase: 'analyze' }) + '\n');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  PROFILES,
  parseArgs,
  analyzeImages,
  classifyImages,
  collectImages,
  // Heuristics (exported for testing)
  detectOversized,
  detectWrongFormat,
  detectMissingSrcset,
  detectLcpFetchpriority,
  detectAboveFoldLazy,
  detectBelowFoldEager,
  pickLcpCandidate,
};
