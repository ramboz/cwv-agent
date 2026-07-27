#!/usr/bin/env node
/**
 * Sanity tests for image-analysis heuristics.
 *
 * Runs without a browser — feeds hand-built image snapshots to classifyImages()
 * and asserts positive/negative cases for each of the 6 heuristics.
 * Every emitted finding is validated via validateFinding().
 *
 * Exit code: 0 on success, 1 on any failure.
 */


import { validateFinding } from '../../finding-schema.js';
import {
  parseArgs,
  classifyImages,
  detectOversized,
  detectWrongFormat,
  detectMissingSrcset,
  detectLcpFetchpriority,
  detectAboveFoldLazy,
  detectBelowFoldEager,
  pickLcpCandidate,
} from '../image-analysis.js';

const PAGE_URL = 'https://example.com/';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  failures.push(msg);
  process.stderr.write(`FAIL: ${msg}\n`);
}

function assertValidFindings(findings, label) {
  for (const f of findings) {
    const res = validateFinding(f);
    assert(res.valid, `${label}: finding ${f.id} should validate; errors=${JSON.stringify(res.errors)}`);
  }
}

// Base image factory with sane defaults.
function img(overrides = {}) {
  return {
    url: 'https://example.com/a.jpg',
    src: '/a.jpg',
    srcset: '',
    sizes: '',
    loading: '',
    decoding: '',
    fetchpriority: '',
    naturalWidth: 400,
    naturalHeight: 300,
    renderedWidth: 400,
    renderedHeight: 300,
    top: 100,
    aboveFold: true,
    displayed: true,
    dpr: 1,
    contentType: 'image/jpeg',
    bytes: 30 * 1024,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CLI: --stealth pass-through for Cloudflare-fronted targets.
// ---------------------------------------------------------------------------
{
  const args = parseArgs(['--url', PAGE_URL, '--stealth']);
  assert(args.stealth === true, '--stealth parses to true');
  assert(parseArgs(['--url', PAGE_URL]).stealth === false, 'stealth defaults false');
}

// ---------------------------------------------------------------------------
// Heuristic 1: oversized
// ---------------------------------------------------------------------------
{
  // Positive: 2400x1800 natural served into 400x300 @ dpr=2 → ~9x oversized.
  const big = img({
    url: 'https://example.com/big.jpg',
    naturalWidth: 2400,
    naturalHeight: 1800,
    renderedWidth: 400,
    renderedHeight: 300,
    dpr: 2,
    bytes: 800 * 1024,
  });
  const out = detectOversized([big], PAGE_URL, 0);
  assert(out.length === 1, 'oversized positive: 1 finding expected');
  assert(out[0].type === 'waste', 'oversized positive: type waste');
  assert(out[0].impactReduction.valueMs > 0, 'oversized positive: impact > 0');
  assertValidFindings(out, 'oversized positive');
}
{
  // Negative: 400x300 natural into 400x300 @ dpr=1 → no waste.
  const ok = img({
    naturalWidth: 400,
    naturalHeight: 300,
    renderedWidth: 400,
    renderedHeight: 300,
    dpr: 1,
  });
  const out = detectOversized([ok], PAGE_URL, 0);
  assert(out.length === 0, 'oversized negative: no finding');
}

// ---------------------------------------------------------------------------
// Heuristic 2: wrong format
// ---------------------------------------------------------------------------
{
  // Positive: 200 KB JPEG.
  const jpg = img({ url: 'https://example.com/photo.jpg', contentType: 'image/jpeg', bytes: 200 * 1024 });
  const out = detectWrongFormat([jpg], PAGE_URL, 0);
  assert(out.length === 1, 'wrong-format positive: 1 finding');
  assert(out[0].type === 'opportunity', 'wrong-format positive: type opportunity');
  assertValidFindings(out, 'wrong-format positive');
}
{
  // Negative: 200 KB WebP.
  const webp = img({ contentType: 'image/webp', bytes: 200 * 1024 });
  const out = detectWrongFormat([webp], PAGE_URL, 0);
  assert(out.length === 0, 'wrong-format negative (webp): no finding');
}
{
  // Negative: small JPEG (under 50 KB threshold).
  const tiny = img({ contentType: 'image/jpeg', bytes: 10 * 1024 });
  const out = detectWrongFormat([tiny], PAGE_URL, 0);
  assert(out.length === 0, 'wrong-format negative (tiny): no finding');
}

// ---------------------------------------------------------------------------
// Heuristic 3: missing srcset
// ---------------------------------------------------------------------------
{
  // Positive: 1200px natural rendered at 400px, no srcset, >10KB.
  const noSrcset = img({
    naturalWidth: 1200,
    naturalHeight: 900,
    renderedWidth: 400,
    renderedHeight: 300,
    srcset: '',
    bytes: 80 * 1024,
  });
  const out = detectMissingSrcset([noSrcset], PAGE_URL, 0);
  assert(out.length === 1, 'missing-srcset positive: 1 finding');
  assertValidFindings(out, 'missing-srcset positive');
}
{
  // Negative: has srcset.
  const withSrcset = img({
    naturalWidth: 1200,
    naturalHeight: 900,
    renderedWidth: 400,
    renderedHeight: 300,
    srcset: '/a-400.jpg 400w, /a-800.jpg 800w',
    bytes: 80 * 1024,
  });
  const out = detectMissingSrcset([withSrcset], PAGE_URL, 0);
  assert(out.length === 0, 'missing-srcset negative: no finding');
}

// ---------------------------------------------------------------------------
// Heuristic 4: LCP fetchpriority
// ---------------------------------------------------------------------------
{
  // Positive: biggest above-fold image, no fetchpriority.
  const hero = img({
    url: 'https://example.com/hero.jpg',
    renderedWidth: 1200,
    renderedHeight: 600,
    aboveFold: true,
    fetchpriority: '',
  });
  const side = img({
    url: 'https://example.com/side.jpg',
    renderedWidth: 200,
    renderedHeight: 150,
    aboveFold: true,
  });
  const lcp = pickLcpCandidate([hero, side]);
  assert(lcp && lcp.url === hero.url, 'LCP candidate should be the largest above-fold image');
  const out = detectLcpFetchpriority([hero, side], PAGE_URL, 0);
  assert(out.length === 1, 'lcp-fetchpriority positive: 1 finding');
  assert(out[0].patches && out[0].patches.markup && out[0].patches.markup[0].attrs.fetchpriority === 'high',
    'lcp-fetchpriority positive: patch sets fetchpriority=high');
  assertValidFindings(out, 'lcp-fetchpriority positive');
}
{
  // Negative: LCP image already has fetchpriority=high.
  const hero = img({ renderedWidth: 1200, renderedHeight: 600, aboveFold: true, fetchpriority: 'high' });
  const out = detectLcpFetchpriority([hero], PAGE_URL, 0);
  assert(out.length === 0, 'lcp-fetchpriority negative: no finding');
}

// ---------------------------------------------------------------------------
// Heuristic 5: above-the-fold lazy
// ---------------------------------------------------------------------------
{
  // Positive.
  const lazyHero = img({ aboveFold: true, loading: 'lazy' });
  const out = detectAboveFoldLazy([lazyHero], PAGE_URL, 0);
  assert(out.length === 1, 'above-fold-lazy positive: 1 finding');
  assert(out[0].type === 'bottleneck', 'above-fold-lazy positive: type bottleneck');
  assertValidFindings(out, 'above-fold-lazy positive');
}
{
  // Negative: below-fold lazy is fine.
  const below = img({ aboveFold: false, loading: 'lazy' });
  const out = detectAboveFoldLazy([below], PAGE_URL, 0);
  assert(out.length === 0, 'above-fold-lazy negative: no finding');
}

// ---------------------------------------------------------------------------
// Heuristic 6: below-fold eager (aggregated)
// ---------------------------------------------------------------------------
{
  // Positive: 3 below-fold images, none lazy — expect single aggregate finding.
  const bf = [
    img({ url: 'https://example.com/bf1.jpg', aboveFold: false, loading: '', bytes: 40 * 1024 }),
    img({ url: 'https://example.com/bf2.jpg', aboveFold: false, loading: '', bytes: 40 * 1024 }),
    img({ url: 'https://example.com/bf3.jpg', aboveFold: false, loading: '', bytes: 40 * 1024 }),
  ];
  const out = detectBelowFoldEager(bf, PAGE_URL, 0);
  assert(out.length === 1, 'below-fold-eager positive: aggregate finding');
  assert(Array.isArray(out[0].evidence[0].data.match) && out[0].evidence[0].data.match.length === 3,
    'below-fold-eager positive: all 3 urls listed');
  assert(out[0].patches.markup.length === 3, 'below-fold-eager positive: 3 patches');
  assertValidFindings(out, 'below-fold-eager positive');
}
{
  // Negative: all below-fold images already lazy.
  const bf = [
    img({ aboveFold: false, loading: 'lazy' }),
    img({ aboveFold: false, loading: 'lazy' }),
  ];
  const out = detectBelowFoldEager(bf, PAGE_URL, 0);
  assert(out.length === 0, 'below-fold-eager negative: no finding');
}

// ---------------------------------------------------------------------------
// Integration: classifyImages end-to-end
// ---------------------------------------------------------------------------
{
  // Build a page with one of each offender, validate all findings.
  const heroBig = img({
    url: 'https://example.com/hero.jpg',
    naturalWidth: 2400, naturalHeight: 1800,
    renderedWidth: 800, renderedHeight: 600,
    dpr: 1,
    contentType: 'image/jpeg',
    bytes: 500 * 1024,
    aboveFold: true,
    fetchpriority: '', // triggers LCP-fetchpriority
    loading: '',
  });
  const bf = img({
    url: 'https://example.com/bf.jpg',
    aboveFold: false,
    loading: '',
    bytes: 100 * 1024,
    contentType: 'image/jpeg',
  });
  const result = classifyImages(PAGE_URL, [heroBig, bf]);
  assert(result.invalid.length === 0, `integration: no invalid findings (got ${result.invalid.length})`);
  assert(result.findings.length >= 3, `integration: expected ≥3 findings (got ${result.findings.length})`);
  assertValidFindings(result.findings, 'integration');
  // Ensure evidence kinds are allowed by schema.
  for (const f of result.findings) {
    for (const e of f.evidence) {
      assert(typeof e.kind === 'string' && typeof e.data === 'object',
        `integration: evidence shape on ${f.id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
process.stdout.write(`\nimage-analysis.test: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stderr.write(`Failures:\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}
process.exit(0);
