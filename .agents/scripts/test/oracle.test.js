#!/usr/bin/env node

/**
 * Tests for oracle.js — the numeric verdict script.
 *
 * Covers percentile math, IQR overlap detection, per-metric comparison
 * verdicts (VALIDATED / REGRESSION / INCONCLUSIVE / BELOW_THRESHOLD), and
 * overall roll-up logic. Uses synthetic launcher.json fixtures — no browser.
 */

import {
  EXIT_CODES,
  extractSamples,
  extractSourceSamples,
  percentile,
  median,
  summarize,
  iqrOverlap,
  detectNoOp,
  compareMetric,
  rollUp,
  evaluate,
  manualReviewVerdict,
  verdictForClassification,
} from '../oracle.js';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}\n`);
}

function test(name, fn) {
  try { fn(); record(name, true); }
  catch (err) { record(name, false, err && err.message); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function approxEq(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function mkLauncher(url, lcpSamples, other = {}) {
  return {
    url,
    profile: 'mobile-slow4g-4xcpu',
    viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
    runs: lcpSamples.map((v, i) => ({
      cwv: {
        lcp:  { value: v, rating: v < 2500 ? 'good' : v < 4000 ? 'needs-improvement' : 'poor' },
        cls:  other.cls != null ? { value: other.cls[i], rating: 'good' } : { value: null, reason: 'not-observed' },
        inp:  other.inp != null ? { value: other.inp[i], rating: 'good' } : { value: null, reason: 'not-observed' },
        fcp:  { value: null, reason: 'not-observed' },
        ttfb: { value: null, reason: 'not-observed' },
      },
      resources: null,
      timestamp: new Date(Date.UTC(2026, 3, 17, 0, 0, i)).toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Percentile / median / summarize
// ---------------------------------------------------------------------------

test('percentile: p50 of odd-count sorted input', () => {
  assert(percentile([1, 2, 3, 4, 5], 50) === 3);
});

test('percentile: p75 uses linear interpolation (R type-7)', () => {
  // samples=[10,20,30,40]; rank=0.75*(4-1)=2.25; p75 = 30 + 0.25*(40-30) = 32.5
  assert(approxEq(percentile([10, 20, 30, 40], 75), 32.5), 'expected 32.5');
});

test('percentile: single-sample returns that sample', () => {
  assert(percentile([42], 75) === 42);
});

test('percentile: empty returns null', () => {
  assert(percentile([], 50) === null);
});

test('median: alias of p50', () => {
  assert(median([5, 1, 3, 4, 2]) === 3);
});

test('summarize: n, median, IQR', () => {
  const s = summarize([100, 200, 300, 400, 500]);
  assert(s.n === 5, `n=${s.n}`);
  assert(s.median === 300, `median=${s.median}`);
  assert(s.p25 === 200, `p25=${s.p25}`);
  assert(s.p75 === 400, `p75=${s.p75}`);
  assert(s.iqr[0] === 200 && s.iqr[1] === 400, `iqr=${JSON.stringify(s.iqr)}`);
});

test('summarize: empty yields nulls, n=0', () => {
  const s = summarize([]);
  assert(s.n === 0);
  assert(s.median === null);
  assert(s.iqr === null);
});

// ---------------------------------------------------------------------------
// IQR overlap
// ---------------------------------------------------------------------------

test('iqrOverlap: disjoint intervals do not overlap', () => {
  assert(iqrOverlap([1, 2], [3, 4]) === false);
});

test('iqrOverlap: touching intervals overlap (closed)', () => {
  assert(iqrOverlap([1, 3], [3, 5]) === true);
});

test('iqrOverlap: fully contained intervals overlap', () => {
  assert(iqrOverlap([1, 10], [3, 5]) === true);
});

test('iqrOverlap: null input returns false', () => {
  assert(iqrOverlap(null, [1, 2]) === false);
});

// ---------------------------------------------------------------------------
// extractSamples
// ---------------------------------------------------------------------------

test('extractSamples: skips null values', () => {
  const l = mkLauncher('https://x.test/', [1000, 2000, 3000]);
  l.runs[1].cwv.lcp.value = null;
  const s = extractSamples(l, 'LCP', 0);
  assert(s.length === 2, `got ${s.length}`);
  assert(s[0] === 1000 && s[1] === 3000);
});

test('extractSamples: drops warmup runs', () => {
  const l = mkLauncher('https://x.test/', [5000, 5000, 1000, 2000, 3000]);
  const s = extractSamples(l, 'LCP', 2);
  assert(s.length === 3, `got ${s.length}`);
  assert(s[0] === 1000 && s[2] === 3000);
});

test('extractSamples: unobserved metric yields empty array', () => {
  const l = mkLauncher('https://x.test/', [1000, 2000]);
  const s = extractSamples(l, 'INP', 0);
  assert(s.length === 0);
});

// ---------------------------------------------------------------------------
// compareMetric — single-metric verdicts
// ---------------------------------------------------------------------------

test('compareMetric: non-overlapping IQR + improvement → VALIDATED high', () => {
  // Baseline clusters 4000-4500; treatment 2500-3000. No overlap, delta ~ -1500.
  const base = summarize([4000, 4100, 4200, 4300, 4400, 4500]);
  const treat = summarize([2500, 2600, 2700, 2800, 2900, 3000]);
  const r = compareMetric('LCP', base, treat);
  assert(r.verdict === 'VALIDATED', `got ${r.verdict}`);
  assert(r.confidence === 'high', `got ${r.confidence}`);
  assert(r.iqrOverlap === false);
  assert(r.delta < -200, `delta=${r.delta}`);
});

test('compareMetric: overlapping IQR but medians clearly separated → VALIDATED medium', () => {
  // Base IQR ~ [3300, 4100], median 3800. Treat IQR ~ [2000, 3400], median 2900.
  // IQRs overlap on [3300, 3400]; treatment median 2900 < baseline p25 3300 → VALIDATED medium.
  const base = summarize([2000, 3200, 3400, 3800, 4000, 4200, 5500]);
  const treat = summarize([1500, 1800, 2200, 2900, 3000, 3800, 5000]);
  const r = compareMetric('LCP', base, treat);
  assert(r.verdict === 'VALIDATED', `got ${r.verdict} (${r.reason})`);
  assert(r.confidence === 'medium', `got ${r.confidence}`);
  assert(r.iqrOverlap === true);
});

test('compareMetric: overlapping IQRs, medians within each other → INCONCLUSIVE', () => {
  // Base IQR [3225, 3950], median 3600. Treat IQR [2925, 3650], median 3300.
  // Delta = -300 (above MIN_IMPACT=200). IQRs overlap [3225, 3650]. Neither median
  // is below the other's p25, so not clearly separated → INCONCLUSIVE.
  const base = summarize([2800, 3000, 3300, 3500, 3700, 3900, 4100, 4300]);
  const treat = summarize([2500, 2700, 3000, 3200, 3400, 3600, 3800, 4000]);
  const r = compareMetric('LCP', base, treat);
  assert(r.verdict === 'INCONCLUSIVE', `got ${r.verdict} (${r.reason})`);
  assert(r.iqrOverlap === true);
});

test('compareMetric: treatment worse past MIN_ACTIONABLE_IMPACT → REGRESSION', () => {
  // LCP MIN_IMPACT.delta = 200. Treatment 500ms worse.
  const base = summarize([2000, 2100, 2200, 2300, 2400]);
  const treat = summarize([2500, 2600, 2700, 2800, 2900]);
  const r = compareMetric('LCP', base, treat);
  assert(r.verdict === 'REGRESSION', `got ${r.verdict}`);
  assert(r.delta > 0, `delta=${r.delta}`);
});

test('compareMetric: improvement below MIN_ACTIONABLE_IMPACT → BELOW_THRESHOLD', () => {
  // LCP MIN_IMPACT.delta = 200. Treatment only 50ms faster.
  const base = summarize([2500, 2510, 2520, 2530, 2540]);
  const treat = summarize([2450, 2460, 2470, 2480, 2490]);
  const r = compareMetric('LCP', base, treat);
  assert(r.verdict === 'BELOW_THRESHOLD', `got ${r.verdict}`);
  assert(r.meetsMinImpact === false);
});

test('compareMetric: CLS delta uses score units and smaller MIN_IMPACT', () => {
  // CLS MIN_IMPACT.delta = 0.03.
  const base = summarize([0.15, 0.16, 0.17, 0.18, 0.19]);
  const treat = summarize([0.05, 0.06, 0.07, 0.08, 0.09]);
  const r = compareMetric('CLS', base, treat);
  assert(r.unit === 'score', `unit=${r.unit}`);
  assert(r.verdict === 'VALIDATED', `got ${r.verdict}`);
  assert(r.delta < -0.03, `delta=${r.delta}`);
});

test('compareMetric: empty samples on one side → INCONCLUSIVE', () => {
  const base = summarize([2000, 2100, 2200]);
  const treat = summarize([]);
  const r = compareMetric('LCP', base, treat);
  assert(r.verdict === 'INCONCLUSIVE');
  assert(r.reason.includes('insufficient samples'));
});

// ---------------------------------------------------------------------------
// rollUp — overall verdict
// ---------------------------------------------------------------------------

test('rollUp: all target metrics VALIDATED, no regressions → VALIDATED', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'VALIDATED' }, { metric: 'INP', verdict: 'VALIDATED' }],
    ['LCP', 'INP'],
  );
  assert(v === 'VALIDATED', `got ${v}`);
});

test('rollUp: any REGRESSION short-circuits to REGRESSION', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'VALIDATED' }, { metric: 'CLS', verdict: 'REGRESSION' }],
    ['LCP'],
  );
  assert(v === 'REGRESSION', `got ${v}`);
});

test('rollUp: non-target regression also blocks promotion', () => {
  // LCP validated (target) but INP regressed (non-target) → still REGRESSION overall.
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'VALIDATED' }, { metric: 'INP', verdict: 'REGRESSION' }],
    ['LCP'],
  );
  assert(v === 'REGRESSION', `got ${v}`);
});

test('rollUp: target INCONCLUSIVE with no regression → INCONCLUSIVE', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'INCONCLUSIVE' }, { metric: 'CLS', verdict: 'VALIDATED' }],
    ['LCP'],
  );
  assert(v === 'INCONCLUSIVE', `got ${v}`);
});

test('rollUp: target BELOW_THRESHOLD, no regression → BELOW_THRESHOLD', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'BELOW_THRESHOLD' }],
    ['LCP'],
  );
  assert(v === 'BELOW_THRESHOLD', `got ${v}`);
});

// ---------------------------------------------------------------------------
// evaluate() end-to-end
// ---------------------------------------------------------------------------

test('evaluate: end-to-end LCP improvement → VALIDATED, exit 0', () => {
  const base = mkLauncher('https://x.test/', [4000, 4100, 4200, 4300, 4400, 4500]);
  const treat = mkLauncher('https://x.test/', [2500, 2600, 2700, 2800, 2900, 3000]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'VALIDATED', `got ${v.verdict}`);
  assert(v.exitCode === EXIT_CODES.VALIDATED, `exitCode=${v.exitCode}`);
  assert(v.metrics.length === 1);
  assert(v.metrics[0].metric === 'LCP');
  assert(v.runsBaseline === 6);
  assert(v.runsTreatment === 6);
});

test('evaluate: warmup drops from both sides', () => {
  const base = mkLauncher('https://x.test/', [9999, 9999, 4000, 4100, 4200, 4300]);
  const treat = mkLauncher('https://x.test/', [9999, 9999, 2500, 2600, 2700, 2800]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 2 });
  assert(v.verdict === 'VALIDATED', `got ${v.verdict}`);
  assert(v.runsBaseline === 4);
  assert(v.runsTreatment === 4);
  // Warmup outliers should not pollute the IQR.
  assert(v.metrics[0].baseline.max <= 4300);
});

test('evaluate: unknown metric throws', () => {
  const base = mkLauncher('https://x.test/', [4000]);
  const treat = mkLauncher('https://x.test/', [3000]);
  let threw = false;
  try { evaluate({ baseline: base, treatment: treat, metrics: ['FOO'], warmup: 0 }); }
  catch { threw = true; }
  assert(threw, 'should throw on unknown metric');
});

test('evaluate: regression exit code = 1', () => {
  const base = mkLauncher('https://x.test/', [2000, 2100, 2200, 2300]);
  const treat = mkLauncher('https://x.test/', [2800, 2900, 3000, 3100]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'REGRESSION');
  assert(v.exitCode === EXIT_CODES.REGRESSION);
});

test('evaluate: target non-regression, INP non-target regression → REGRESSION overall', () => {
  // LCP improves; INP regresses; target is LCP only.
  const base = mkLauncher('https://x.test/', [4000, 4100, 4200, 4300], { inp: [120, 130, 140, 150] });
  const treat = mkLauncher('https://x.test/', [2500, 2600, 2700, 2800], { inp: [250, 260, 270, 280] });
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP', 'INP'], warmup: 0 });
  // INP target too; it regressed; overall REGRESSION.
  assert(v.verdict === 'REGRESSION', `got ${v.verdict}`);
  assert(v.exitCode === 1);
});

// ---------------------------------------------------------------------------
// detectNoOp — tolerance-identical sample detection
// ---------------------------------------------------------------------------

test('detectNoOp: bit-identical samples are NO_OP', () => {
  const base = [2000, 2100, 2200, 2300, 2400];
  const treat = [2000, 2100, 2200, 2300, 2400];
  const r = detectNoOp(base, treat, 2200);
  assert(r.isNoOp === true, `expected NO_OP, got ${JSON.stringify(r)}`);
  assert(r.maxDiff === 0, `maxDiff=${r.maxDiff}`);
});

test('detectNoOp: tolerance-identical but not bit-identical is NO_OP', () => {
  // Relative tolerance: 1e-9 * |median| = 2e-9 at median 2.0 — but absolute
  // floor 1e-6 dominates here. 1e-12 is well below 1e-6.
  const base = [1.0, 2.0, 3.0];
  const treat = [1.0 + 1e-12, 2.0, 3.0];
  const r = detectNoOp(base, treat, 2.0);
  assert(r.isNoOp === true, `expected NO_OP, got ${JSON.stringify(r)}`);
  assert(r.maxDiff > 0 && r.maxDiff < 1e-6);
});

test('detectNoOp: sub-threshold but real delta is NOT NO_OP', () => {
  // A real 50ms shift on LCP ≈ 2000 is above the 1e-6 tolerance by ~8 orders
  // of magnitude — must NOT be classified as NO_OP even though it's below
  // the 200ms MIN_ACTIONABLE_IMPACT floor.
  const base = [2000, 2010, 2020, 2030, 2040];
  const treat = [2050, 2060, 2070, 2080, 2090];
  const r = detectNoOp(base, treat, 2020);
  assert(r.isNoOp === false, `expected NOT NO_OP, got ${JSON.stringify(r)}`);
});

test('detectNoOp: mismatched sample counts disable NO_OP detection', () => {
  const r = detectNoOp([1, 2, 3, 4], [1, 2, 3], 2.5);
  assert(r.isNoOp === false);
});

test('detectNoOp: empty sides disable NO_OP detection', () => {
  assert(detectNoOp([], [], 0).isNoOp === false);
  assert(detectNoOp([1, 2], [], 1.5).isNoOp === false);
});

test('detectNoOp: samples in different order still match (sorted compare)', () => {
  const base = [2000, 2400, 2200, 2100, 2300];
  const treat = [2300, 2100, 2000, 2400, 2200];
  const r = detectNoOp(base, treat, 2200);
  assert(r.isNoOp === true, 'sorted-positional compare should match permutations');
});

// ---------------------------------------------------------------------------
// evaluate() NO_OP scenarios
// ---------------------------------------------------------------------------

test('evaluate: bit-identical LCP samples → NO_OP, exit 5', () => {
  const values = [2000, 2100, 2200, 2300, 2400];
  const base = mkLauncher('https://x.test/', values);
  const treat = mkLauncher('https://x.test/', values);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'NO_OP', `got ${v.verdict}`);
  assert(v.exitCode === EXIT_CODES.NO_OP, `exitCode=${v.exitCode}`);
  assert(v.metrics[0].verdict === 'NO_OP');
  assert(v.metrics[0].reason.includes('did not apply'));
});

test('evaluate: the the pets-site case case — CLS identical to many decimals → NO_OP', () => {
  // Reproduces the 2026-04-17 the pets-site case diagnose-cls-c6-3 case: CLS
  // identical to 17 decimals across 5 samples each side.
  const cls = [
    0.09197906605871387,
    0.09197906605871387,
    0.09197906605871387,
    0.09197906605871387,
    0.09197906605871387,
  ];
  const base = mkLauncher('https://the pets-site case.test/', [2000, 2100, 2200, 2300, 2400], { cls });
  const treat = mkLauncher('https://the pets-site case.test/', [2000, 2100, 2200, 2300, 2400], { cls });
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['CLS'], warmup: 0 });
  assert(v.verdict === 'NO_OP', `got ${v.verdict} (${v.metrics[0].reason})`);
  assert(v.exitCode === 5);
});

test('evaluate: tolerance-identical samples → NO_OP', () => {
  const base = mkLauncher('https://x.test/', [1000, 2000, 3000]);
  const treat = mkLauncher('https://x.test/', [1000 + 1e-10, 2000, 3000]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'NO_OP', `got ${v.verdict}`);
});

test('evaluate: real sub-floor LCP delta → BELOW_THRESHOLD, NOT NO_OP', () => {
  // LCP baseline median 2020, treatment median 2070. Delta = 50ms, below
  // the 200ms MIN_ACTIONABLE_IMPACT floor, but *real* — must route to
  // BELOW_THRESHOLD (exit 3), never to NO_OP.
  const base = mkLauncher('https://x.test/', [2000, 2010, 2020, 2030, 2040]);
  const treat = mkLauncher('https://x.test/', [2050, 2060, 2070, 2080, 2090]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'BELOW_THRESHOLD', `got ${v.verdict}`);
  assert(v.exitCode === EXIT_CODES.BELOW_THRESHOLD);
});

test('evaluate: multi-metric LCP NO_OP + CLS regression → REGRESSION', () => {
  // LCP samples identical on both sides (NO_OP for LCP), but CLS regresses
  // past MIN_IMPACT (0.03). A real regression on any moved metric beats
  // silence on another.
  const lcp = [2000, 2100, 2200, 2300, 2400];
  const base = mkLauncher('https://x.test/', lcp, { cls: [0.05, 0.06, 0.05, 0.06, 0.05] });
  const treat = mkLauncher('https://x.test/', lcp, { cls: [0.15, 0.16, 0.15, 0.16, 0.15] });
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP', 'CLS'], warmup: 0 });
  assert(v.verdict === 'REGRESSION', `got ${v.verdict}`);
  assert(v.exitCode === EXIT_CODES.REGRESSION);
  const lcpResult = v.metrics.find((m) => m.metric === 'LCP');
  const clsResult = v.metrics.find((m) => m.metric === 'CLS');
  assert(lcpResult.verdict === 'NO_OP');
  assert(clsResult.verdict === 'REGRESSION');
});

test('evaluate: multi-metric LCP NO_OP + CLS NO_OP → NO_OP', () => {
  const lcp = [2000, 2100, 2200, 2300, 2400];
  const cls = [0.05, 0.06, 0.07, 0.08, 0.09];
  const base = mkLauncher('https://x.test/', lcp, { cls });
  const treat = mkLauncher('https://x.test/', lcp, { cls });
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP', 'CLS'], warmup: 0 });
  assert(v.verdict === 'NO_OP', `got ${v.verdict}`);
  assert(v.exitCode === 5);
  for (const m of v.metrics) assert(m.verdict === 'NO_OP');
});

test('evaluate: multi-metric LCP NO_OP + CLS validated → VALIDATED', () => {
  // LCP unchanged (NO_OP). CLS strongly improves (non-overlapping IQRs,
  // delta > MIN_IMPACT 0.03). Overall: VALIDATED on the moved metric.
  const lcp = [2000, 2100, 2200, 2300, 2400];
  const base = mkLauncher('https://x.test/', lcp, { cls: [0.15, 0.16, 0.17, 0.18, 0.19] });
  const treat = mkLauncher('https://x.test/', lcp, { cls: [0.05, 0.06, 0.07, 0.08, 0.09] });
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP', 'CLS'], warmup: 0 });
  assert(v.verdict === 'VALIDATED', `got ${v.verdict} (${JSON.stringify(v.metrics.map((m) => [m.metric, m.verdict]))})`);
  assert(v.exitCode === EXIT_CODES.VALIDATED);
  const lcpResult = v.metrics.find((m) => m.metric === 'LCP');
  const clsResult = v.metrics.find((m) => m.metric === 'CLS');
  assert(lcpResult.verdict === 'NO_OP');
  assert(clsResult.verdict === 'VALIDATED');
});

// ---------------------------------------------------------------------------
// rollUp NO_OP behaviour (unit-level)
// ---------------------------------------------------------------------------

test('rollUp: all target metrics NO_OP → NO_OP', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'NO_OP' }, { metric: 'CLS', verdict: 'NO_OP' }],
    ['LCP', 'CLS'],
  );
  assert(v === 'NO_OP', `got ${v}`);
});

test('rollUp: NO_OP on a non-target does not force overall NO_OP', () => {
  // LCP (target) validated; CLS (not a target) NO_OP — overall VALIDATED.
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'VALIDATED' }, { metric: 'CLS', verdict: 'NO_OP' }],
    ['LCP'],
  );
  assert(v === 'VALIDATED', `got ${v}`);
});

test('rollUp: mixed NO_OP + VALIDATED target → VALIDATED', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'NO_OP' }, { metric: 'CLS', verdict: 'VALIDATED' }],
    ['LCP', 'CLS'],
  );
  assert(v === 'VALIDATED', `got ${v}`);
});

test('rollUp: NO_OP target + REGRESSION on any metric → REGRESSION', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'NO_OP' }, { metric: 'CLS', verdict: 'REGRESSION' }],
    ['LCP', 'CLS'],
  );
  assert(v === 'REGRESSION', `got ${v}`);
});

// ---------------------------------------------------------------------------
// NOT_MEASURED (zero samples on both sides) — #12
// Metric the runner didn't capture (e.g. INP without --interact) should be
// silent in rollup instead of forcing INCONCLUSIVE.
// ---------------------------------------------------------------------------

test('evaluate: INP zero-samples on both sides → NOT_MEASURED, silent', () => {
  // LCP moved enough to validate; INP has n=0 in both runs (no --interact).
  // Overall should be VALIDATED — not INCONCLUSIVE.
  const base = mkLauncher('https://x.test/', [3200, 3300, 3400, 3500, 3600]);
  const treat = mkLauncher('https://x.test/', [2000, 2050, 2100, 2150, 2200]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP', 'INP'], warmup: 0 });
  const inp = v.metrics.find((m) => m.metric === 'INP');
  assert(inp.verdict === 'NOT_MEASURED', `INP verdict=${inp.verdict}`);
  assert(inp.baseline.n === 0 && inp.treatment.n === 0, `INP n baseline=${inp.baseline.n} treatment=${inp.treatment.n}`);
  assert(v.verdict === 'VALIDATED', `overall=${v.verdict}`);
  assert(v.exitCode === EXIT_CODES.VALIDATED);
});

test('evaluate: sole target with zero samples → NOT_MEASURED, exit 6', () => {
  const base = mkLauncher('https://x.test/', [2000, 2100, 2200]);
  const treat = mkLauncher('https://x.test/', [2000, 2100, 2200]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['INP'], warmup: 0 });
  assert(v.verdict === 'NOT_MEASURED', `got ${v.verdict}`);
  assert(v.exitCode === EXIT_CODES.NOT_MEASURED);
  assert(v.exitCode === 6);
});

test('evaluate: asymmetric zero samples → UNRELIABLE (reliability gate, was INCONCLUSIVE)', () => {
  // Baseline has INP samples; treatment doesn't. That's a real asymmetry —
  // the treatment side couldn't be measured. The G2 reliability gate surfaces
  // this as UNRELIABLE ("re-measure"), more precise than the old INCONCLUSIVE
  // ("noise dominates a real comparison"). NOT NOT_MEASURED — that's reserved
  // for BOTH sides empty.
  const base = mkLauncher('https://x.test/', [2000, 2100, 2200], { inp: [150, 160, 170] });
  const treat = mkLauncher('https://x.test/', [2000, 2100, 2200]); // no inp
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['INP'], warmup: 0 });
  const inp = v.metrics.find((m) => m.metric === 'INP');
  assert(inp.verdict === 'UNRELIABLE', `got ${inp.verdict}`);
  assert(/treatment: only 0/.test(inp.reason), `reason=${inp.reason}`);
  assert(v.verdict === 'UNRELIABLE' && v.exitCode === 7, `overall=${v.verdict} exit=${v.exitCode}`);
});

test('rollUp: all targets NOT_MEASURED → NOT_MEASURED', () => {
  const v = rollUp(
    [{ metric: 'INP', verdict: 'NOT_MEASURED' }, { metric: 'TBT', verdict: 'NOT_MEASURED' }],
    ['INP', 'TBT'],
  );
  assert(v === 'NOT_MEASURED', `got ${v}`);
});

test('rollUp: NOT_MEASURED target + VALIDATED target → VALIDATED', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'VALIDATED' }, { metric: 'INP', verdict: 'NOT_MEASURED' }],
    ['LCP', 'INP'],
  );
  assert(v === 'VALIDATED', `got ${v}`);
});

test('rollUp: NOT_MEASURED + NO_OP measured target → NO_OP', () => {
  // LCP was captured but the patch no-op'd; INP wasn't captured at all.
  // The signal is the NO_OP — fall through to it.
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'NO_OP' }, { metric: 'INP', verdict: 'NOT_MEASURED' }],
    ['LCP', 'INP'],
  );
  assert(v === 'NO_OP', `got ${v}`);
});

test('rollUp: NOT_MEASURED target + REGRESSION on any metric → REGRESSION', () => {
  const v = rollUp(
    [{ metric: 'INP', verdict: 'NOT_MEASURED' }, { metric: 'LCP', verdict: 'REGRESSION' }],
    ['INP', 'LCP'],
  );
  assert(v === 'REGRESSION', `got ${v}`);
});

// ---------------------------------------------------------------------------
// UNRELIABLE (G2 — could-not-measure-reliably)
// ---------------------------------------------------------------------------

test('evaluate: too-few samples (n<min) → UNRELIABLE, not a spurious VALIDATED', () => {
  // 2 samples each: the old path would compute a (degenerate) IQR and could
  // VALIDATE. The reliability gate (default minSamples=3) blocks it.
  const base = mkLauncher('https://x.test/', [4000, 4100]);
  const treat = mkLauncher('https://x.test/', [2000, 2100]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  const lcp = v.metrics.find((m) => m.metric === 'LCP');
  assert(lcp.verdict === 'UNRELIABLE', `got ${lcp.verdict}`);
  assert(lcp.reliability && lcp.reliability.baseline.n === 2, 'reliability detail attached');
  assert(v.verdict === 'UNRELIABLE' && v.exitCode === 7, `overall=${v.verdict} exit=${v.exitCode}`);
});

test('evaluate: --min-samples 2 lets a 2-sample comparison through', () => {
  const base = mkLauncher('https://x.test/', [4000, 4100]);
  const treat = mkLauncher('https://x.test/', [2000, 2100]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0, minSamples: 2 });
  const lcp = v.metrics.find((m) => m.metric === 'LCP');
  assert(lcp.verdict !== 'UNRELIABLE', `expected a real verdict, got ${lcp.verdict}`);
});

test('evaluate: very noisy samples (IQR ≫ median) → UNRELIABLE', () => {
  // Wild spread on the treatment side — relIQR way over 0.6.
  const base = mkLauncher('https://x.test/', [3000, 3050, 3100, 3150]);
  const treat = mkLauncher('https://x.test/', [500, 3000, 6000, 12000]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  const lcp = v.metrics.find((m) => m.metric === 'LCP');
  assert(lcp.verdict === 'UNRELIABLE', `got ${lcp.verdict}`);
  assert(/too noisy/.test(lcp.reason), `reason=${lcp.reason}`);
});

test('evaluate: --max-rel-spread negative disables the noise gate', () => {
  const base = mkLauncher('https://x.test/', [3000, 3050, 3100, 3150]);
  const treat = mkLauncher('https://x.test/', [500, 3000, 6000, 12000]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0, maxRelSpread: null });
  const lcp = v.metrics.find((m) => m.metric === 'LCP');
  assert(lcp.verdict !== 'UNRELIABLE', `expected a real verdict, got ${lcp.verdict}`);
});

test('evaluate: near-zero CLS with wide relative IQR is NOT flagged noisy', () => {
  // CLS median ~0.01 with IQR ~0.01 → relIQR ~1.0, but absolutely stable.
  // The spread floor must skip the noise gate here.
  const lcp = [2000, 2100, 2200, 2300];
  const base = mkLauncher('https://x.test/', lcp, { cls: [0.005, 0.01, 0.015, 0.02] });
  const treat = mkLauncher('https://x.test/', lcp, { cls: [0.005, 0.01, 0.015, 0.02] });
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['CLS'], warmup: 0 });
  const cls = v.metrics.find((m) => m.metric === 'CLS');
  assert(cls.verdict !== 'UNRELIABLE', `near-zero CLS wrongly flagged: ${cls.verdict} (${cls.reason})`);
});

test('rollUp: sole UNRELIABLE target → UNRELIABLE', () => {
  assert(rollUp([{ metric: 'CLS', verdict: 'UNRELIABLE' }], ['CLS']) === 'UNRELIABLE');
});

test('rollUp: UNRELIABLE is silent when a sibling target moved (VALIDATED wins)', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'VALIDATED' }, { metric: 'CLS', verdict: 'UNRELIABLE' }],
    ['LCP', 'CLS'],
  );
  assert(v === 'VALIDATED', `got ${v}`);
});

test('rollUp: UNRELIABLE + NOT_MEASURED (all silent) → UNRELIABLE (most actionable)', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'UNRELIABLE' }, { metric: 'INP', verdict: 'NOT_MEASURED' }],
    ['LCP', 'INP'],
  );
  assert(v === 'UNRELIABLE', `got ${v}`);
});

test('rollUp: REGRESSION beats UNRELIABLE', () => {
  const v = rollUp(
    [{ metric: 'LCP', verdict: 'REGRESSION' }, { metric: 'CLS', verdict: 'UNRELIABLE' }],
    ['LCP', 'CLS'],
  );
  assert(v === 'REGRESSION', `got ${v}`);
});

// ---------------------------------------------------------------------------
// Per-source CLS validation (--cls-source) + A/A noise-floor gate (--baseline2)
// ---------------------------------------------------------------------------

// Launcher fixture carrying total cls.value AND cls.shiftSources[]. rows[i] is
// the shift-source list for run i: [{ node, clsShare }, ...].
function mkLauncherSources(url, clsTotals, rows) {
  return {
    url,
    profile: 'mobile-slow4g-4xcpu',
    viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
    runs: rows.map((sources, i) => ({
      cwv: {
        lcp: { value: 2000, rating: 'good' },
        cls: {
          value: clsTotals[i],
          rating: 'needs-improvement',
          shiftSources: sources.map((s) => ({ node: s.node, clsShare: s.clsShare, shifts: 1, grewEvents: 1 })),
        },
        inp: { value: null, reason: 'not-observed' },
        fcp: { value: null, reason: 'not-observed' },
        ttfb: { value: null, reason: 'not-observed' },
      },
      resources: null,
      timestamp: new Date(Date.UTC(2026, 5, 10, 0, 0, i)).toISOString(),
    })),
  };
}

const BANNER = 'div#c > div.t004-cookie > section.cookies__container.font-lato';
const LISTW = 'div.tab__content > ul.list__container--scroll > li.list__wrapper';

test('extractSourceSamples: sums matching sources; a run that matched none → 0', () => {
  const l = mkLauncherSources('https://x/', [0.2, 0.1, 0.09], [
    [{ node: BANNER, clsShare: 0.07 }, { node: LISTW, clsShare: 0.13 }],
    [{ node: LISTW, clsShare: 0.10 }],                                            // no banner → 0
    [{ node: 'a.cookies__head', clsShare: 0.05 }, { node: 'b.cookies__foot', clsShare: 0.02 }], // sum 0.07
  ]);
  const s = extractSourceSamples(l, 'cookies__', 0);
  assert(s.length === 3, `len ${s.length}`);
  assert(approxEq(s[0], 0.07) && s[1] === 0 && approxEq(s[2], 0.07), JSON.stringify(s));
});

test('extractSourceSamples: leading dot trimmed; run with no shiftSources is skipped (not 0)', () => {
  const l = mkLauncherSources('https://x/', [0.1, 0.1], [
    [{ node: BANNER, clsShare: 0.07 }],
    [{ node: 'x', clsShare: 0.01 }],
  ]);
  delete l.runs[1].cwv.cls.shiftSources;
  const s = extractSourceSamples(l, '.cookies__container', 0);
  assert(s.length === 1 && approxEq(s[0], 0.07), JSON.stringify(s));
});

test('evaluate --cls-source: stable banner → ~0 VALIDATES per-source even when total CLS is too noisy to trust', () => {
  // Total CLS dominated by a volatile content module → UNRELIABLE (noise gate);
  // the stable banner source drops to ~0 → the clean, validatable signal.
  const noisy = [0.18, 0.37, 0.27, 0.18, 0.40];   // absIQR>0.1 AND relSpread>0.6 → UNRELIABLE
  const noisy2 = [0.20, 0.39, 0.26, 0.17, 0.41];
  const bBase = [0.070, 0.071, 0.069, 0.070, 0.072];
  const bTreat = [0.000, 0.001, 0.000, 0.002, 0.001];
  const base = mkLauncherSources('https://x/', noisy, noisy.map((t, i) => ([
    { node: BANNER, clsShare: bBase[i] }, { node: LISTW, clsShare: +(t - bBase[i]).toFixed(4) },
  ])));
  const treat = mkLauncherSources('https://x/', noisy2, noisy2.map((t, i) => ([
    { node: BANNER, clsShare: bTreat[i] }, { node: LISTW, clsShare: +(t - bTreat[i]).toFixed(4) },
  ])));
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['CLS'], clsSource: 'cookies__container', warmup: 0 });
  const total = v.metrics.find((m) => m.metric === 'CLS');
  const src = v.metrics.find((m) => m.metric === 'CLS@cookies__container');
  assert(total.verdict === 'UNRELIABLE', `total CLS should be UNRELIABLE, got ${total.verdict}`);
  assert(src && src.verdict === 'VALIDATED', `per-source should VALIDATE, got ${src && src.verdict}`);
  assert(src.source === 'cookies__container', 'source recorded on the entry');
  assert(v.verdict === 'VALIDATED' && v.exitCode === 0, `overall=${v.verdict} exit=${v.exitCode}`);
});

test('evaluate --cls-source: a volatile source self-flags UNRELIABLE (cannot be validated)', () => {
  const flip = (arr) => mkLauncherSources('https://x/', arr.map(() => 0.2), arr.map((c) => [{ node: LISTW, clsShare: c }]));
  const base = flip([0.00, 0.13, 0.00, 0.22, 0.09]);   // swings 0↔0.22 → absIQR>0.1, relSpread huge
  const treat = flip([0.10, 0.00, 0.18, 0.00, 0.12]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], clsSource: 'list__wrapper', warmup: 0 });
  const src = v.metrics.find((m) => m.metric === 'CLS@list__wrapper');
  assert(src && src.verdict === 'UNRELIABLE', `volatile source should be UNRELIABLE, got ${src && src.verdict}`);
});

test('evaluate --cls-source: source unchanged by the patch → CLS@source NO_OP', () => {
  const shares = [0.070, 0.071, 0.069, 0.070, 0.072];
  const mk = () => mkLauncherSources('https://x/', shares.map(() => 0.2), shares.map((s) => [{ node: BANNER, clsShare: s }]));
  const v = evaluate({ baseline: mk(), treatment: mk(), metrics: ['LCP'], clsSource: 'cookies__container', warmup: 0 });
  const src = v.metrics.find((m) => m.metric === 'CLS@cookies__container');
  assert(src.verdict === 'NO_OP', `got ${src.verdict}`);
});

test('evaluate --baseline2 (A/A gate): total-CLS A/B is gated UNRELIABLE when the two no-patch baselines themselves move; the stable per-source still VALIDATES', () => {
  const mk = (clsArr, bannerArr) => mkLauncherSources('https://x/', clsArr, clsArr.map((t, i) => [
    { node: BANNER, clsShare: bannerArr[i] }, { node: LISTW, clsShare: +(t - bannerArr[i]).toFixed(4) },
  ]));
  const baseline = mk([0.27, 0.275, 0.265, 0.27, 0.272], [0.070, 0.071, 0.069, 0.070, 0.072]);
  const baseline2 = mk([0.19, 0.195, 0.185, 0.19, 0.192], [0.070, 0.069, 0.071, 0.070, 0.070]); // no patch, lower total
  const treatment = mk([0.20, 0.205, 0.195, 0.20, 0.198], [0.000, 0.001, 0.000, 0.002, 0.001]); // banner fixed
  const v = evaluate({ baseline, treatment, baseline2, metrics: ['CLS'], clsSource: 'cookies__container', warmup: 0 });
  const total = v.metrics.find((m) => m.metric === 'CLS');
  const src = v.metrics.find((m) => m.metric === 'CLS@cookies__container');
  assert(total.verdict === 'UNRELIABLE' && total.aa, `total CLS should be A/A-gated UNRELIABLE, got ${total.verdict}`);
  assert(/A\/A control/.test(total.reason), `reason should cite the A/A control: ${total.reason}`);
  assert(src.verdict === 'VALIDATED', `banner per-source should still VALIDATE, got ${src.verdict}`);
  assert(v.verdict === 'VALIDATED', `overall should be VALIDATED via per-source, got ${v.verdict}`);
});

test('evaluate --baseline2 (A/A gate): statistically-similar baselines do NOT gate — the A/B verdict stands', () => {
  const mk = (clsArr) => mkLauncherSources('https://x/', clsArr, clsArr.map((t) => [{ node: LISTW, clsShare: t }]));
  const baseline = mk([0.27, 0.26, 0.28, 0.27, 0.265]);
  const baseline2 = mk([0.265, 0.27, 0.275, 0.26, 0.27]);  // overlaps baseline → A/A is not a "move"
  const treatment = mk([0.20, 0.205, 0.195, 0.20, 0.198]); // a real improvement
  const v = evaluate({ baseline, treatment, baseline2, metrics: ['CLS'], warmup: 0 });
  const total = v.metrics.find((m) => m.metric === 'CLS');
  assert(!total.aa, 'A/A should not gate when baselines are statistically similar');
  assert(total.verdict === 'VALIDATED', `A/B verdict should stand, got ${total.verdict}`);
});

// ---------------------------------------------------------------------------
// Viewport carry-through (spec 003-06)
//
// The launcher records the rendered viewport; evaluate() must surface it on the
// verdict so a validate run states the viewport it compared at. CLS *score* is
// viewport-relative, so a baseline/treatment comparison is only valid at the
// same viewport — making the recorded viewport part of the verdict's contract.
// ---------------------------------------------------------------------------

test('evaluate: carries the rendered viewport onto the verdict', () => {
  const base = mkLauncher('https://x.test/', [3000, 3100, 2950]);
  const treat = mkLauncher('https://x.test/', [2400, 2450, 2380]);
  base.viewport = { width: 1350, height: 940 };
  treat.viewport = { width: 1350, height: 940 };
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.viewport && v.viewport.width === 1350 && v.viewport.height === 940,
    `viewport should be carried through, got ${JSON.stringify(v.viewport)}`);
});

test('evaluate: same profile name with different viewport is UNRELIABLE and names both viewports', () => {
  const base = mkLauncher('https://x.test/', [3000, 3100, 2950]);
  const treat = mkLauncher('https://x.test/', [2400, 2450, 2380]);
  base.viewport = { width: 800, height: 600 };
  treat.viewport = { width: 1350, height: 940 };
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'UNRELIABLE' && v.exitCode === 7, `got ${v.verdict} exit=${v.exitCode}`);
  assert(v.incomparable && v.incomparable.reason === 'viewport-mismatch',
    `expected viewport-mismatch, got ${JSON.stringify(v.incomparable)}`);
  assert(v.incomparable.baselineViewport.width === 800 && v.incomparable.treatmentViewport.width === 1350,
    `should name both viewports, got ${JSON.stringify(v.incomparable)}`);
  assert(v.metrics.length === 0, 'incomparable inputs should not produce per-metric verdicts');
});

test('evaluate: different profile names with identical viewport are comparable on the viewport axis', () => {
  const base = mkLauncher('https://x.test/', [3000, 3100, 2950]);
  const treat = mkLauncher('https://x.test/', [2400, 2450, 2380]);
  base.profile = 'desktop-slow-1xcpu';
  treat.profile = 'desktop-cable-1xcpu';
  base.viewport = { width: 1350, height: 940, deviceScaleFactor: 1 };
  treat.viewport = { width: 1350, height: 940, deviceScaleFactor: 1 };
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'VALIDATED', `matching viewports should compare normally, got ${v.verdict}`);
  assert(!v.incomparable, `should not flag incomparable, got ${JSON.stringify(v.incomparable)}`);
});

test('evaluate: baseline2 viewport mismatch is UNRELIABLE before A/A gating', () => {
  const base = mkLauncher('https://x.test/', [3000, 3100, 2950]);
  const treat = mkLauncher('https://x.test/', [2400, 2450, 2380]);
  const base2 = mkLauncher('https://x.test/', [3020, 3080, 3000]);
  base.viewport = { width: 1350, height: 940, deviceScaleFactor: 1 };
  treat.viewport = { width: 1350, height: 940, deviceScaleFactor: 1 };
  base2.viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
  const v = evaluate({ baseline: base, treatment: treat, baseline2: base2, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'UNRELIABLE' && v.exitCode === 7, `got ${v.verdict} exit=${v.exitCode}`);
  assert(v.incomparable && v.incomparable.comparison === 'baseline-baseline2',
    `expected baseline-baseline2 mismatch, got ${JSON.stringify(v.incomparable)}`);
  assert(v.incomparable.baseline2Viewport.width === 800,
    `should name baseline2 viewport, got ${JSON.stringify(v.incomparable)}`);
  assert(v.aaGate === true, 'output should still indicate that --baseline2 was supplied');
});

test('evaluate: missing viewport degrades to UNRELIABLE rather than a clean verdict', () => {
  const base = mkLauncher('https://x.test/', [3000, 3100, 2950]);
  const treat = mkLauncher('https://x.test/', [2400, 2450, 2380]);
  delete base.viewport;
  delete treat.viewport;
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'UNRELIABLE' && v.exitCode === 7, `got ${v.verdict} exit=${v.exitCode}`);
  assert(v.incomparable && v.incomparable.reason === 'missing-viewport',
    `expected missing-viewport, got ${JSON.stringify(v.incomparable)}`);
  assert(v.incomparable.baselineViewport === null && v.incomparable.treatmentViewport === null,
    `missing viewports should be null, got ${JSON.stringify(v.incomparable)}`);
});

test('evaluate: deviceScaleFactor mismatch is flagged when both viewports carry it', () => {
  const base = mkLauncher('https://x.test/', [3000, 3100, 2950]);
  const treat = mkLauncher('https://x.test/', [2400, 2450, 2380]);
  base.viewport = { width: 390, height: 844, deviceScaleFactor: 2 };
  treat.viewport = { width: 390, height: 844, deviceScaleFactor: 3 };
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict === 'UNRELIABLE', `got ${v.verdict}`);
  assert(v.incomparable.fields.includes('deviceScaleFactor'),
    `expected deviceScaleFactor mismatch, got ${JSON.stringify(v.incomparable)}`);
});

// ---------------------------------------------------------------------------
// manual-review — a PRE-MEASUREMENT typed refusal. A structural fix is never
// measured; the verdict is minted directly, never derived from sample
// comparison.
// ---------------------------------------------------------------------------

test('manualReviewVerdict: typed verdict + exit code 8, oracle-shaped, empty metrics', () => {
  const v = manualReviewVerdict({ metric: 'CLS', reason: 'restructures the template DOM shape' });
  assert(v.verdict === 'manual-review', `got ${v.verdict}`);
  assert(v.exitCode === EXIT_CODES.MANUAL_REVIEW, `got exit ${v.exitCode}`);
  assert(v.exitCode === 8, `MANUAL_REVIEW must be 8, got ${v.exitCode}`);
  assert(v.manualReview === true, 'carries manualReview flag');
  assert(Array.isArray(v.metrics) && v.metrics.length === 0, 'no per-metric entries — never measured');
  assert(v.metric === 'CLS', `metric carried through, got ${v.metric}`);
  // never masked as a measurement outcome.
  assert(v.verdict !== 'VALIDATED' && v.verdict !== 'NO_OP' && v.verdict !== 'INCONCLUSIVE',
    'must not masquerade as a sample-comparison verdict');
});

test('manualReviewVerdict: reason says land-in-source and re-measure', () => {
  const v = manualReviewVerdict({ metric: 'CLS', reason: 'structural template change' });
  assert(/source/i.test(v.reason), `reason must point at a source change, got: ${v.reason}`);
  assert(/re-measure/i.test(v.reason), `reason must instruct to re-measure, got: ${v.reason}`);
});

test('verdictForClassification: route manual-review → manual-review verdict, without measuring', () => {
  const entry = { class: 3, subclass: 'structural', route: 'manual-review',
    rationale: 'structural DOM-shape change' };
  const v = verdictForClassification(entry, { metric: 'CLS' });
  assert(v && v.verdict === 'manual-review', `got ${v && v.verdict}`);
  assert(v.exitCode === 8, `got exit ${v.exitCode}`);
  assert(v.metric === 'CLS', `metric carried, got ${v.metric}`);
  // the entry's own rationale is threaded into the reason so the operator sees WHY.
  assert(v.reason.includes(entry.rationale), 'reason includes the classification rationale');
});

test('verdictForClassification: non-manual-review routes return null (go through normal validate)', () => {
  for (const route of ['patch', 'source-edit']) {
    assert(verdictForClassification({ route }, { metric: 'CLS' }) === null,
      `route ${route} must NOT short-circuit to manual-review`);
  }
  assert(verdictForClassification(null, { metric: 'CLS' }) === null, 'null entry → null');
  assert(verdictForClassification({}, {}) === null, 'no route → null');
});

test('evaluate / rollUp NEVER emit manual-review from sample comparison (structural fixes never reach measurement)', () => {
  // A perfectly good A/B measurement must roll up to a measurement verdict, not
  // the pre-measurement refusal — manual-review lives entirely outside the
  // sample-comparison path.
  const base = mkLauncher('https://x.test/', [4000, 4100, 4200, 4300]);
  const treat = mkLauncher('https://x.test/', [2500, 2600, 2700, 2800]);
  const v = evaluate({ baseline: base, treatment: treat, metrics: ['LCP'], warmup: 0 });
  assert(v.verdict !== 'manual-review', 'evaluate must never mint manual-review');
  // and rollUp over any mix of measured verdicts never yields it either.
  const rolled = rollUp([
    { metric: 'LCP', verdict: 'VALIDATED' },
    { metric: 'CLS', verdict: 'NO_OP' },
  ], ['LCP', 'CLS']);
  assert(rolled !== 'manual-review', 'rollUp must never yield manual-review');
});

// ---------------------------------------------------------------------------
// Kill-criterion guard: the manual-review path introduces NO server-side
// render emulation. Assert oracle.js documents the deliberate refusal.
// ---------------------------------------------------------------------------

test('oracle.js documents the manual-review refusal (no faked structural emulation)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'oracle.js'), 'utf8');
  assert(/manual-review/i.test(src), 'oracle.js documents the manual-review refusal');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) {
  for (const f of failed) process.stdout.write(`  FAIL: ${f.name} — ${f.detail}\n`);
  process.exit(1);
}
process.exit(0);
