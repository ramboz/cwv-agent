#!/usr/bin/env node

/**
 * Sanity tests for coverage.js analyzer logic.
 *
 * Uses hand-built fake coverage data — no browser spawn. Exits 0 on success,
 * 1 on first failed assertion.
 */

import {
  parseArgs,
  computeCoverageRows,
  buildFindings,
  JS_TOTAL_BYTES_MIN,
  AGGREGATE_CRITICAL_PATH_MIN_UNUSED,
} from '../coverage.js';
import { validateFinding } from '../../finding-schema.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; process.stdout.write(`  ok  ${msg}\n`); }
  else { failed++; process.stderr.write(`  FAIL ${msg}\n`); }
}

function section(title) {
  process.stdout.write(`\n# ${title}\n`);
}

// ---------------------------------------------------------------------------
// Helpers to build fake Puppeteer coverage entries.
// ---------------------------------------------------------------------------
function fakeJs({ url, totalBytes, unusedPct }) {
  const usedBytes = Math.round(totalBytes * (1 - unusedPct / 100));
  return { url, text: 'x'.repeat(totalBytes), ranges: [{ start: 0, end: usedBytes }] };
}

function fakeCss({ url, totalBytes, unusedPct }) {
  const usedBytes = Math.round(totalBytes * (1 - unusedPct / 100));
  return { url, text: 'y'.repeat(totalBytes), ranges: [{ start: 0, end: usedBytes }] };
}

// ---------------------------------------------------------------------------
// Test 1: 50KB script with 80% unused should emit a waste finding.
// ---------------------------------------------------------------------------
section('50KB script 80% unused → waste finding');
{
  const js = [fakeJs({ url: 'https://example.com/app.js', totalBytes: 50 * 1024, unusedPct: 80 })];
  const rows = computeCoverageRows(js, []);
  assert(rows.js[0].totalBytes === 50 * 1024, 'total bytes computed from text');
  assert(Math.abs(rows.js[0].unusedPct - 80) < 0.5, `unusedPct ≈ 80 (got ${rows.js[0].unusedPct.toFixed(2)})`);

  const findings = buildFindings(rows, { url: 'https://example.com/', assumeRenderCritical: true });
  assert(findings.length >= 1, `at least one finding emitted (got ${findings.length})`);
  const f = findings[0];
  assert(f.type === 'waste', `type=waste (got ${f.type})`);
  assert(f.source === 'coverage', 'source=coverage');
  assert(f.confidence <= 0.85, `confidence ≤ 0.85 (got ${f.confidence})`);
  assert(Array.isArray(f.evidence) && f.evidence[0].kind === 'coverage-row', 'has coverage-row evidence');
  assert(f.evidence[0].data.unusedBytes > 0, 'coverage-row includes unusedBytes');
  assert(f.metric.includes('LCP') && f.metric.includes('TBT') && f.metric.includes('INP'), 'JS metric includes LCP, TBT, INP');

  const v = validateFinding(f);
  assert(v.valid, `finding validates (errors: ${v.errors.join('; ')})`);
}

// ---------------------------------------------------------------------------
// CLI: --stealth pass-through for Cloudflare-fronted targets.
// ---------------------------------------------------------------------------
section('CLI accepts --stealth');
{
  const args = parseArgs(['--url', 'https://example.com/', '--stealth']);
  assert(args.stealth === true, '--stealth parses to true');
  assert(parseArgs(['--url', 'https://example.com/']).stealth === false, 'stealth defaults false');
}

// ---------------------------------------------------------------------------
// Test 2: 5KB script with 90% unused should NOT emit a per-script finding
// (below size threshold).
// ---------------------------------------------------------------------------
section('5KB script 90% unused → no per-script finding');
{
  const js = [fakeJs({ url: 'https://example.com/tiny.js', totalBytes: 5 * 1024, unusedPct: 90 })];
  const rows = computeCoverageRows(js, []);
  assert(rows.js[0].totalBytes < JS_TOTAL_BYTES_MIN, 'row below size threshold');
  const findings = buildFindings(rows, { url: 'https://example.com/', assumeRenderCritical: true });
  assert(findings.length === 0, `no findings emitted (got ${findings.length})`);
}

// ---------------------------------------------------------------------------
// Test 3: aggregate critical-path waste crossing 100KB → summary finding.
// ---------------------------------------------------------------------------
section('Aggregate critical-path waste ≥ 100KB → summary finding');
{
  // Three render-blocking JS: 40KB, 50KB, 60KB each @ 80% unused
  // → 32 + 40 + 48 = 120KB unused ≥ 100KB.
  const js = [
    fakeJs({ url: 'https://example.com/a.js', totalBytes: 40 * 1024, unusedPct: 80 }),
    fakeJs({ url: 'https://example.com/b.js', totalBytes: 50 * 1024, unusedPct: 80 }),
    fakeJs({ url: 'https://example.com/c.js', totalBytes: 60 * 1024, unusedPct: 80 }),
  ];
  const rows = computeCoverageRows(js, []);
  const unusedSum = rows.js.reduce((a, r) => a + r.unusedBytes, 0);
  assert(unusedSum >= AGGREGATE_CRITICAL_PATH_MIN_UNUSED, `aggregate ≥ 100KB (got ${unusedSum})`);

  const findings = buildFindings(rows, { url: 'https://example.com/', assumeRenderCritical: true });
  const aggregate = findings.find((f) => f.rootCause === true);
  assert(!!aggregate, 'aggregate summary finding emitted');
  assert(aggregate && aggregate.evidence.length === 3, `summary has 3 coverage-row evidence entries (got ${aggregate && aggregate.evidence.length})`);
  assert(aggregate && aggregate.metric.includes('LCP'), 'summary targets LCP');

  // All findings should validate.
  for (const f of findings) {
    const v = validateFinding(f);
    assert(v.valid, `finding ${f.id} validates (errors: ${v.errors.join('; ')})`);
  }
}

// ---------------------------------------------------------------------------
// Test 4: vendor bundle signal should augment recommendation.
// ---------------------------------------------------------------------------
section('Vendor bundle signal → code-splitting recommendation');
{
  const js = [fakeJs({ url: 'https://cdn.example.com/vendor.min.js', totalBytes: 200 * 1024, unusedPct: 75 })];
  const rows = computeCoverageRows(js, []);
  const findings = buildFindings(rows, { url: 'https://example.com/', assumeRenderCritical: true });
  assert(findings.length >= 1, 'per-script finding emitted');
  assert(/code-split/i.test(findings[0].recommendation), 'recommendation mentions code-split');
}

// ---------------------------------------------------------------------------
// Test 5: CSS 15KB @ 70% unused → waste finding with LCP+FCP.
// ---------------------------------------------------------------------------
section('CSS 15KB 70% unused → waste finding');
{
  const css = [fakeCss({ url: 'https://example.com/main.css', totalBytes: 15 * 1024, unusedPct: 70 })];
  const rows = computeCoverageRows([], css);
  const findings = buildFindings(rows, { url: 'https://example.com/', assumeRenderCritical: true });
  assert(findings.length >= 1, 'CSS finding emitted');
  const cssFinding = findings.find((f) => f.metric.includes('FCP'));
  assert(!!cssFinding, 'CSS finding targets FCP');
  assert(cssFinding.type === 'waste', 'CSS finding type=waste');
  const v = validateFinding(cssFinding);
  assert(v.valid, `CSS finding validates (errors: ${v.errors.join('; ')})`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
process.stdout.write(`\n— ${passed} passed, ${failed} failed —\n`);
process.exit(failed === 0 ? 0 : 1);
