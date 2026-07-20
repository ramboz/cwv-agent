#!/usr/bin/env node

/**
 * oracle.js — deterministic numeric verdict for cwv-agent.
 *
 * Compares two launcher.js JSON outputs (baseline vs treatment) across a set
 * of target metrics, computes per-metric statistics (median, IQR), applies
 * the comparison rules from .agents/skills/cwv-validate.md Step 5, and emits
 * a machine-readable verdict with exit code.
 *
 * Usage:
 *   node .agents/scripts/oracle.js \
 *     --baseline  progress/<slug>/baseline.json \
 *     --treatment progress/<slug>/experiments/<id>/result.json \
 *     --metrics   LCP,INP \
 *     --output    progress/<slug>/experiments/<id>/verdict.json
 *
 * Exit codes:
 *   0 = VALIDATED       (all target metrics improved; no regressions)
 *   1 = REGRESSION      (any metric worse past MIN_ACTIONABLE_IMPACT)
 *   2 = INCONCLUSIVE    (IQR overlap; noise dominates delta)
 *   3 = BELOW_THRESHOLD (signal present but below MIN_ACTIONABLE_IMPACT)
 *   4 = ERROR           (bad inputs / missing data)
 *   5 = NO_OP           (treatment samples match baseline within numeric
 *                        tolerance — the patch almost certainly did not
 *                        apply; investigate the patch applier, not the metric)
 *   6 = NOT_MEASURED    (all target metrics had zero samples on both sides —
 *                        the runner did not capture them. Typically INP
 *                        without `--interact`, or a metric a profile/page
 *                        doesn't emit. Drop the metric from --metrics or
 *                        re-run with the missing prerequisite.)
 *   7 = UNRELIABLE      (a target metric HAS samples but too few (< --min-samples)
 *                        or too noisy (IQR/median > --max-rel-spread) to trust —
 *                        e.g. a heavy ad page that yields 0–1 usable samples under
 *                        throttle. Re-measure with more runs (`--max-runs`), a
 *                        lighter profile, or `--block` the noise source. Distinct
 *                        from INCONCLUSIVE, which is a real comparison whose delta
 *                        is within noise. Also used when launcher outputs are
 *                        not comparable, such as mismatched or missing recorded
 *                        viewports.)
 *   8 = MANUAL_REVIEW  (a PRE-MEASUREMENT refusal, NOT a sample-comparison
 *                        outcome. A structural fix alters the DOM shape or
 *                        execution order the server renders; a served-byte
 *                        patch cannot faithfully emulate that, so this verdict
 *                        is minted directly at the classify→validate boundary
 *                        and shipped as guidance-only. evaluate() / rollUp()
 *                        NEVER return it.)
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { MIN_IMPACT, METRICS } from './finding-schema.js';
import { assessReliability, DEFAULTS as QUALITY_DEFAULTS } from './measure-quality.js';

// CLS is a "lower-is-better" score metric. All others are ms. CLS is the only
// metric where impactReduction uses `score` rather than `valueMs`. No metric
// is "higher-is-better" in CWV land.
const METRIC_UNITS = {
  LCP: 'ms', CLS: 'score', INP: 'ms', FCP: 'ms', TTFB: 'ms', TBT: 'ms', SI: 'ms',
};

const HELP = `
oracle.js — numeric verdict for cwv-agent

Usage:
  node .agents/scripts/oracle.js [flags]

Flags:
  --baseline <path>    Launcher JSON to compare against (required)
  --treatment <path>   Launcher JSON of the candidate (required)
  --baseline2 <path>   Optional second no-patch baseline → enables the A/A noise-floor
                       gate: any metric whose two baselines themselves differ past
                       MIN_ACTIONABLE_IMPACT (with separated medians) is marked
                       UNRELIABLE — the page's run-to-run drift exceeds the effect size,
                       so an A/B verdict on that metric can't be trusted (use --cls-source).
  --cls-source <sel>   Also validate the CLS contribution of shift sources whose node
                       matches <sel> (a class/selector substring, e.g. cookies__container),
                       as a CLS@<sel> target. On multi-source pages total CLS is dominated
                       by unrelated run-to-run variance; the targeted source is the clean
                       signal (a stable source validates; a volatile one self-flags UNRELIABLE).
  --metrics <list>     Comma-separated target metrics (default: LCP,CLS,INP,FCP,TTFB)
                       Non-target metrics are watched for REGRESSION only.
  --warmup <N>         Drop the first N runs of each file before stats (default: 0)
  --min-samples <N>    Min valid samples per side for a metric to be reliable;
                       below this → UNRELIABLE (default: 3)
  --max-rel-spread <f> Max IQR/|median| before a metric is too noisy → UNRELIABLE.
                       Pass a negative value to disable the spread gate (default: 0.6)
  --output <path>      Write verdict JSON to file (default: stdout)
  --help               Print this help and exit 0

Exit codes:
  0 = VALIDATED, 1 = REGRESSION, 2 = INCONCLUSIVE, 3 = BELOW_THRESHOLD,
  4 = ERROR, 5 = NO_OP, 6 = NOT_MEASURED, 7 = UNRELIABLE

Viewport comparability:
  The baseline, treatment, and optional --baseline2 launcher outputs must carry
  the same recorded viewport (width x height, plus deviceScaleFactor when both
  sides record it). Missing or mismatched viewports produce an UNRELIABLE verdict
  with an "incomparable" object instead of a clean comparison.
`;

function parseArgs(argv) {
  const args = {
    baseline: null,
    treatment: null,
    baseline2: null,
    clsSource: null,
    metrics: ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'],
    warmup: 0,
    minSamples: QUALITY_DEFAULTS.minSamples,
    maxRelSpread: QUALITY_DEFAULTS.maxRelSpread,
    output: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--help': case '-h': args.help = true; break;
      case '--baseline': args.baseline = next(); break;
      case '--treatment': args.treatment = next(); break;
      case '--baseline2': args.baseline2 = next(); break;
      case '--cls-source': args.clsSource = next(); break;
      case '--metrics': {
        const v = next() || '';
        args.metrics = v.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--warmup': args.warmup = parseInt(next(), 10) || 0; break;
      case '--min-samples': args.minSamples = parseInt(next(), 10); break;
      case '--max-rel-spread': {
        const v = parseFloat(next());
        // A negative value disables the spread gate (pass null downstream).
        args.maxRelSpread = Number.isFinite(v) ? (v < 0 ? null : v) : QUALITY_DEFAULTS.maxRelSpread;
        break;
      }
      case '--output': args.output = next(); break;
      default:
        if (a && a.startsWith('--')) {
          process.stderr.write(`Unknown flag: ${a}\n`);
          process.exit(4);
        }
    }
  }
  return args;
}

function readLauncherJson(p) {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj || !Array.isArray(obj.runs)) {
    throw new Error(`${p}: expected { runs: [...] } shape`);
  }
  return obj;
}

// Extract numeric samples for a metric across runs, skipping null/not-observed.
// For CWV snapshot shape: runs[i].cwv[<lower(metric)>].value
function extractSamples(launcherJson, metric, warmup) {
  const key = metric.toLowerCase();
  const samples = [];
  const runs = launcherJson.runs.slice(warmup);
  for (const r of runs) {
    const m = r && r.cwv && r.cwv[key];
    if (!m) continue;
    if (typeof m.value !== 'number') continue;
    if (!Number.isFinite(m.value)) continue;
    samples.push(m.value);
  }
  return samples;
}

// Extract a targeted CLS shift-source's per-run contribution. For each run, sums
// the `clsShare` of every entry in `runs[i].cwv.cls.shiftSources[]` whose `node`
// contains `needle` (a class/selector substring, leading dots/space trimmed).
// A run that captured shift sources but matched none contributes 0 (the source
// did not shift — a real measurement, not a gap), so a fix that removes the shift
// shows up as a clean drop to ~0. A run with no shiftSources array at all (e.g. a
// --no-scroll run) is skipped (not measured for this purpose). This lets the
// oracle validate the *targeted* source instead of total CLS, which on a
// multi-source page is dominated by unrelated run-to-run variance.
function extractSourceSamples(launcherJson, needle, warmup) {
  const tok = String(needle || '').replace(/^[.\s]+/, '').trim();
  if (!tok) return [];
  const runs = launcherJson.runs.slice(warmup);
  const samples = [];
  for (const r of runs) {
    const sources = r && r.cwv && r.cwv.cls && Array.isArray(r.cwv.cls.shiftSources)
      ? r.cwv.cls.shiftSources
      : null;
    if (!sources) continue; // run didn't capture shift sources — not measured here
    let sum = 0;
    for (const s of sources) {
      if (s && typeof s.node === 'string' && s.node.includes(tok) && typeof s.clsShare === 'number') {
        sum += s.clsShare;
      }
    }
    samples.push(sum);
  }
  return samples;
}

// Linear-interpolated percentile (type-7, R default). samples should be a
// non-empty sorted copy; we sort internally.
function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function median(samples) { return percentile(samples, 50); }

function summarize(samples) {
  if (!samples.length) {
    return { n: 0, median: null, p25: null, p75: null, min: null, max: null, iqr: null };
  }
  const p25 = percentile(samples, 25);
  const p75 = percentile(samples, 75);
  return {
    n: samples.length,
    median: median(samples),
    p25,
    p75,
    min: Math.min(...samples),
    max: Math.max(...samples),
    iqr: [p25, p75],
  };
}

// Two intervals [a0, a1], [b0, b1] overlap iff max(a0, b0) <= min(a1, b1).
function iqrOverlap(a, b) {
  if (!a || !b) return false;
  return Math.max(a[0], b[0]) <= Math.min(a[1], b[1]);
}

/**
 * NO_OP detection for a single metric — tolerance-identical sample test.
 *
 * A patch that failed to apply (unrecognized action, selector miss, etc.)
 * produces treatment samples numerically indistinguishable from the baseline.
 * We detect this by sorting both sample arrays and comparing them positionally:
 * if the largest paired absolute difference is below a tiny tolerance scaled
 * to the baseline magnitude, the patch was a silent no-op.
 *
 * Tolerance:  max(1e-9 * |baselineMedian|, 1e-6)
 *   - 1e-9 relative: 0.000001% of the baseline — well below any real
 *     measurement jitter (LCP varies in μs at minimum, CLS at ≥1e-4 across
 *     real runs).
 *   - 1e-6 absolute floor: protects against a baseline median of 0 (possible
 *     for CLS on cold-cache runs without layout shifts).
 *
 * Returns { isNoOp, maxDiff, tolerance } so callers can record why.
 * Returns { isNoOp: false } if either side has < 1 sample or the sample
 * counts differ (can't pair cleanly — fall through to the normal path which
 * will flag "insufficient samples" or do the IQR comparison).
 */
function detectNoOp(baseSamples, treatSamples, baseMedian) {
  if (!baseSamples || !treatSamples) return { isNoOp: false };
  if (baseSamples.length === 0 || treatSamples.length === 0) return { isNoOp: false };
  if (baseSamples.length !== treatSamples.length) return { isNoOp: false };

  const tolerance = Math.max(1e-9 * Math.abs(baseMedian || 0), 1e-6);
  const aSorted = baseSamples.slice().sort((a, b) => a - b);
  const bSorted = treatSamples.slice().sort((a, b) => a - b);
  let maxDiff = 0;
  for (let i = 0; i < aSorted.length; i++) {
    const d = Math.abs(aSorted[i] - bSorted[i]);
    if (d > maxDiff) maxDiff = d;
  }
  return { isNoOp: maxDiff < tolerance, maxDiff, tolerance };
}

function roundTo(n, digits) {
  if (n == null || !Number.isFinite(n)) return n;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function roundStats(s, digits) {
  if (!s) return s;
  return {
    n: s.n,
    median: roundTo(s.median, digits),
    p25: roundTo(s.p25, digits),
    p75: roundTo(s.p75, digits),
    min: roundTo(s.min, digits),
    max: roundTo(s.max, digits),
    iqr: s.iqr ? [roundTo(s.iqr[0], digits), roundTo(s.iqr[1], digits)] : null,
  };
}

/**
 * Compare baseline vs treatment for a single metric.
 *
 * Note: NO_OP (tolerance-identical samples) is classified upstream in
 * evaluate() via detectNoOp() as a pre-pass, before this function is called.
 * That ordering is important: a real but tiny delta (e.g. LCP 2000 → 2050)
 * must reach BELOW_THRESHOLD here, not collapse into NO_OP.
 *
 * Rules (mirrors .agents/skills/cwv-validate.md Step 5):
 *  - non-overlapping IQRs, treatment median < baseline median → VALIDATED (strong)
 *  - overlapping IQRs, medians clearly separated              → VALIDATED (moderate)
 *      "clearly separated" = treatment median < baseline p25
 *                         OR baseline median > treatment p75
 *  - medians within each other's IQR                          → INCONCLUSIVE
 *  - treatment median > baseline median by ≥ MIN_IMPACT.delta → REGRESSION
 *  - treatment median > baseline median but delta small       → INCONCLUSIVE
 *  - |delta| < MIN_IMPACT.delta and not a regression          → BELOW_THRESHOLD
 *
 * All CWV metrics are lower-is-better, so improvement = negative delta.
 */
function compareMetric(metric, baseStats, treatStats) {
  const floor = MIN_IMPACT[metric];
  const unit = METRIC_UNITS[metric] || 'ms';
  const base = baseStats.median;
  const treat = treatStats.median;

  const result = {
    metric,
    unit,
    baseline: baseStats,
    treatment: treatStats,
    delta: null,
    deltaPct: null,
    iqrOverlap: iqrOverlap(baseStats.iqr, treatStats.iqr),
    meetsMinImpact: false,
    verdict: 'INCONCLUSIVE',
    confidence: 'low',
    reason: '',
  };

  if (base == null || treat == null) {
    result.verdict = 'INCONCLUSIVE';
    result.reason = `insufficient samples (baseline n=${baseStats.n}, treatment n=${treatStats.n})`;
    return result;
  }

  const delta = treat - base; // negative = improvement
  const deltaPct = base !== 0 ? (delta / base) * 100 : null;
  const digits = unit === 'score' ? 4 : 1;
  result.delta = roundTo(delta, digits);
  result.deltaPct = deltaPct != null ? roundTo(deltaPct, 1) : null;

  const minDelta = floor ? floor.delta : 0;
  const magnitude = Math.abs(delta);
  result.meetsMinImpact = magnitude >= minDelta;

  // Regression: treatment clearly worse.
  if (delta > 0 && magnitude >= minDelta) {
    result.verdict = 'REGRESSION';
    result.confidence = result.iqrOverlap ? 'medium' : 'high';
    result.reason = `treatment median ${roundTo(treat, digits)}${unit === 'ms' ? 'ms' : ''} > baseline ${roundTo(base, digits)}${unit === 'ms' ? 'ms' : ''} by ${roundTo(magnitude, digits)}${unit === 'ms' ? 'ms' : ''} (≥ MIN_ACTIONABLE_IMPACT ${minDelta})`;
    return result;
  }

  // Below threshold: magnitude too small either way.
  if (magnitude < minDelta) {
    result.verdict = 'BELOW_THRESHOLD';
    result.confidence = 'low';
    result.reason = `|delta| ${roundTo(magnitude, digits)} < MIN_ACTIONABLE_IMPACT ${minDelta}`;
    return result;
  }

  // Improvement path: delta is negative and |delta| >= minDelta.
  // Strong: IQRs don't overlap.
  if (!result.iqrOverlap) {
    result.verdict = 'VALIDATED';
    result.confidence = 'high';
    result.reason = `non-overlapping IQRs; treatment median ${roundTo(treat, digits)} < baseline ${roundTo(base, digits)} by ${roundTo(magnitude, digits)}`;
    return result;
  }

  // Moderate: IQRs overlap but medians clearly separated.
  const clearlySeparated =
    treat < baseStats.p25 || base > treatStats.p75;
  if (clearlySeparated) {
    result.verdict = 'VALIDATED';
    result.confidence = 'medium';
    result.reason = `IQRs overlap but treatment median ${roundTo(treat, digits)} below baseline p25 ${roundTo(baseStats.p25, digits)} (or baseline median above treatment p75)`;
    return result;
  }

  // IQRs overlap and medians within each other's IQR → noise dominates.
  result.verdict = 'INCONCLUSIVE';
  result.confidence = 'low';
  result.reason = `IQRs overlap and medians within each other's IQR (baseline=${roundTo(base, digits)} in [${roundTo(treatStats.p25, digits)}, ${roundTo(treatStats.p75, digits)}]; treatment=${roundTo(treat, digits)} in [${roundTo(baseStats.p25, digits)}, ${roundTo(baseStats.p75, digits)}])`;
  return result;
}

/**
 * Roll per-metric verdicts into a single overall verdict.
 *
 * Precedence (evaluated in order):
 *   1. Any REGRESSION on any metric (target or non-target) → REGRESSION.
 *      This holds even if other target metrics were NO_OP / NOT_MEASURED:
 *      a real regression on a metric that *did* move beats silence on
 *      another.
 *   2. All target metrics NOT_MEASURED → NOT_MEASURED overall. The user's
 *      target-metric list is incompatible with what the runner captured
 *      (e.g. only INP targeted but `--interact` wasn't used). Exit 6 so
 *      scripted orchestrators can distinguish "config issue" from "patch
 *      did not apply" (NO_OP, exit 5) and crash-or-bad-inputs (ERROR,
 *      exit 4).
 *   3. All target metrics NO_OP → NO_OP overall. The patch did not apply
 *      anywhere observable; the analyst should investigate the patch
 *      applier, not the metrics. (NOT_MEASURED metrics are treated as
 *      silent for this check — a NO_OP + NOT_MEASURED target roll-up
 *      still counts as NO_OP.)
 *   4. NO_OP / NOT_MEASURED metrics are otherwise silent and excluded
 *      from aggregation. The overall verdict is determined by the moved
 *      metrics only:
 *        - All moved target metrics VALIDATED → VALIDATED.
 *        - Any remaining target metric INCONCLUSIVE → INCONCLUSIVE.
 *        - Any remaining target metric BELOW_THRESHOLD → BELOW_THRESHOLD.
 *        - Fallback → INCONCLUSIVE.
 *
 * Example: LCP NO_OP + CLS VALIDATED → VALIDATED. The patch did not affect
 * LCP (likely by design — it targeted layout), but CLS moved and validated.
 * Example: LCP NO_OP + CLS REGRESSION → REGRESSION.
 * Example: LCP NO_OP + CLS NO_OP → NO_OP (systemic non-application).
 * Example: LCP VALIDATED + INP NOT_MEASURED → VALIDATED. INP wasn't
 *   captured (no --interact), LCP moved — accept the LCP result.
 * Example: INP NOT_MEASURED (sole target) → NOT_MEASURED.
 *
 * UNRELIABLE (ROADMAP G2) is silent for moved-aggregation, exactly like NO_OP /
 * NOT_MEASURED — a metric whose measurement we can't trust doesn't drag down a
 * sibling that measured cleanly. But when EVERY target is silent and any of them
 * is UNRELIABLE, the overall verdict is UNRELIABLE (the most actionable signal:
 * fix the measurement), taking precedence over NOT_MEASURED / NO_OP.
 * Example: CLS UNRELIABLE (sole target) → UNRELIABLE.
 * Example: LCP VALIDATED + CLS UNRELIABLE → VALIDATED (LCP measured cleanly).
 * Example: LCP UNRELIABLE + INP NOT_MEASURED → UNRELIABLE.
 */
function rollUp(perMetric, targetMetrics) {
  const targetSet = new Set(targetMetrics);
  let anyRegression = false;
  let targetCount = 0;
  let targetNoOpCount = 0;
  let targetNotMeasuredCount = 0;
  let targetUnreliableCount = 0;
  const movedVerdicts = []; // VALIDATED / INCONCLUSIVE / BELOW_THRESHOLD on target metrics

  for (const r of perMetric) {
    if (r.verdict === 'REGRESSION') anyRegression = true;
    if (targetSet.has(r.metric)) {
      targetCount += 1;
      // Silent verdicts — excluded from moved aggregation.
      if (r.verdict === 'NOT_MEASURED') { targetNotMeasuredCount += 1; continue; }
      if (r.verdict === 'NO_OP') { targetNoOpCount += 1; continue; }
      if (r.verdict === 'UNRELIABLE') { targetUnreliableCount += 1; continue; }
      if (r.verdict !== 'REGRESSION') movedVerdicts.push(r.verdict);
    }
  }

  // A real regression on any metric (even a non-target) always wins. (A regression
  // only ever comes from a reliable metric — UNRELIABLE is classified upstream.)
  if (anyRegression) return 'REGRESSION';

  // At least one target metric moved (was reliably compared) — aggregate the
  // moved subset; all silent verdicts are ignored here.
  if (movedVerdicts.length > 0) {
    if (movedVerdicts.every((v) => v === 'VALIDATED')) return 'VALIDATED';
    if (movedVerdicts.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
    if (movedVerdicts.includes('BELOW_THRESHOLD')) return 'BELOW_THRESHOLD';
    return 'INCONCLUSIVE';
  }

  // All targets silent. UNRELIABLE is the most actionable → surface it first.
  if (targetUnreliableCount > 0) return 'UNRELIABLE';
  // All target metrics unmeasured → NOT_MEASURED (config issue).
  if (targetCount > 0 && targetNotMeasuredCount === targetCount) return 'NOT_MEASURED';
  // Every measured (captured) target was NO_OP → patch did not apply anywhere.
  const measuredTargetCount = targetCount - targetNotMeasuredCount;
  if (measuredTargetCount > 0 && targetNoOpCount === measuredTargetCount) return 'NO_OP';
  return 'INCONCLUSIVE';
}

const EXIT_CODES = {
  VALIDATED: 0,
  REGRESSION: 1,
  INCONCLUSIVE: 2,
  BELOW_THRESHOLD: 3,
  ERROR: 4,
  NO_OP: 5,
  NOT_MEASURED: 6,
  UNRELIABLE: 7,
  // 8 = MANUAL_REVIEW. A PRE-MEASUREMENT typed refusal for a structural fix (a
  // DOM-shape / execution-order change). It is NEVER produced by sample
  // comparison — evaluate() / rollUp() cannot return it — because a structural
  // render change is never run through the lab. It is minted directly by
  // manualReviewVerdict() at the classify→validate boundary
  // (verdictForClassification) and shipped as guidance-only. We deliberately DO
  // NOT fake a byte-patch emulation of a structural change — an honest
  // manual-review refusal beats a faked low-fidelity pass.
  MANUAL_REVIEW: 8,
};

/**
 * Mint a typed `manual-review` verdict.
 *
 * This is a PRE-MEASUREMENT refusal: a structural fix alters the DOM shape or
 * execution order the server renders, which a served-byte patch cannot
 * faithfully reproduce (interception preserves fetch order, not the renderer's
 * structural output). Rather than fake a low-fidelity pass, we return a
 * first-class, oracle-shaped verdict so callers treat it like any other
 * verdict — but it is NEVER masked as VALIDATED / NO_OP / INCONCLUSIVE, and it
 * carries no per-metric entries because nothing was measured. The fix ships as
 * guidance: land it in source, then re-measure baseline-vs-live.
 *
 * @param {object} args
 * @param {string} [args.metric]  the target metric (recorded, not measured).
 * @param {string} [args.reason]  the classification rationale (threaded in).
 * @returns {{verdict:'manual-review', exitCode:number, metric:string|null,
 *            reason:string, metrics:[], manualReview:true}}
 */
function manualReviewVerdict({ metric = null, reason = '' } = {}) {
  const base = 'manual-review: structural render change; a served-byte patch '
    + 'cannot faithfully emulate it — land it in source and re-measure, not lab-proven here';
  const full = reason ? `${base}. ${reason}` : base;
  return {
    verdict: 'manual-review',
    exitCode: EXIT_CODES.MANUAL_REVIEW,
    metric,
    reason: full,
    metrics: [], // never measured — no per-metric comparison entries
    manualReview: true,
  };
}

/**
 * Routing hook at the classify→validate boundary. Given a classification
 * entry, return a `manual-review` verdict WITHOUT measuring when the entry is
 * on the `manual-review` route (a Class-3 structural change); return `null`
 * for every other route (patch / source-edit) so those fixes go through the
 * normal measured validate path.
 *
 * @param {object|null} entry     a fix-classifier.js entry ({ route, rationale, ... }).
 * @param {object} [opts]
 * @param {string} [opts.metric]  the fix's target metric.
 * @returns {object|null} a manual-review verdict, or null.
 */
function verdictForClassification(entry, { metric = null } = {}) {
  if (!entry || entry.route !== 'manual-review') return null;
  return manualReviewVerdict({ metric, reason: entry.rationale || '' });
}

/**
 * Run one metric's baseline-vs-treatment samples through the full cascade
 * (NOT_MEASURED → UNRELIABLE → NO_OP → compareMetric) and return a perMetric
 * entry. Extracted so the same pipeline serves whole-page metrics, a targeted
 * CLS shift-source (--cls-source), and the A/A control comparison. `opts.label`
 * relabels the entry (e.g. "CLS@cookies__container"); `opts.source` records the
 * matched selector. For a normal metric (label === metric, no source) this is
 * byte-for-byte the behaviour of the original inline cascade.
 */
function compareSamples(metric, baseSamples, treatSamples, relOpts, opts = {}) {
  const label = opts.label || metric;
  const digits = METRIC_UNITS[metric] === 'score' ? 4 : 1;
  const unit = METRIC_UNITS[metric] || 'ms';
  const baseStats = roundStats(summarize(baseSamples), digits);
  const treatStats = roundStats(summarize(treatSamples), digits);
  const tag = (e) => { e.metric = label; if (opts.source) e.source = opts.source; return e; };

  // NOT_MEASURED: 0 samples on BOTH sides (e.g. INP without `--interact`).
  if (baseStats.n === 0 && treatStats.n === 0) {
    return tag({
      metric: label, unit, baseline: baseStats, treatment: treatStats,
      delta: null, deltaPct: null, iqrOverlap: false, meetsMinImpact: false,
      verdict: 'NOT_MEASURED', confidence: 'high',
      reason: `${metric} had 0 samples on both sides — runner did not capture this metric (e.g. INP needs interaction, TBT needs long tasks). Drop from --metrics or re-run with the missing prerequisite.`,
    });
  }

  // UNRELIABLE: too few / too noisy to trust (ROADMAP G2). Classified before
  // NO_OP and before any comparison. For a per-source metric this is what
  // auto-rejects a volatile shift source while passing a stable one.
  const baseRel = assessReliability(baseSamples, { metric, ...relOpts });
  const treatRel = assessReliability(treatSamples, { metric, ...relOpts });
  if (!baseRel.reliable || !treatRel.reliable) {
    const parts = [];
    if (!baseRel.reliable) parts.push(`baseline: ${baseRel.reason}`);
    if (!treatRel.reliable) parts.push(`treatment: ${treatRel.reason}`);
    return tag({
      metric: label, unit, baseline: baseStats, treatment: treatStats,
      delta: null, deltaPct: null, iqrOverlap: false, meetsMinImpact: false,
      verdict: 'UNRELIABLE', confidence: 'high',
      reason: `measurement not reliable enough to compare — ${parts.join('; ')}`,
      reliability: { baseline: baseRel, treatment: treatRel },
    });
  }

  // NO_OP: tolerance-identical samples → patch did not apply.
  const noOp = detectNoOp(baseSamples, treatSamples, baseStats.median);
  if (noOp.isNoOp) {
    return tag({
      metric: label, unit, baseline: baseStats, treatment: treatStats,
      delta: roundTo(0, digits), deltaPct: 0,
      iqrOverlap: iqrOverlap(baseStats.iqr, treatStats.iqr), meetsMinImpact: false,
      verdict: 'NO_OP', confidence: 'high',
      reason: `treatment samples match baseline within tolerance ${noOp.tolerance.toExponential(2)} (max paired diff ${noOp.maxDiff.toExponential(2)}); patch likely did not apply — investigate the patch applier, not the metric`,
    });
  }

  return tag(compareMetric(metric, baseStats, treatStats));
}

/**
 * A/A noise-floor gate: if a control comparison of two *no-patch* baselines
 * itself "moved" on a metric (VALIDATED/REGRESSION past the floor), the page's
 * run-to-run drift exceeds the effect size — mark that metric's A/B entry
 * UNRELIABLE so it can't manufacture a spurious verdict. Mutates and returns
 * `entry`.
 */
function applyAaGate(entry, control) {
  if (!control || (control.verdict !== 'VALIDATED' && control.verdict !== 'REGRESSION')) return entry;
  entry.aa = { verdict: control.verdict, delta: control.delta };
  entry.verdict = 'UNRELIABLE';
  entry.confidence = 'high';
  entry.reason = `A/A control: two no-patch baselines themselves differ by Δ ${control.delta} (${control.verdict}) — the page's run-to-run drift on ${entry.metric} exceeds MIN_ACTIONABLE_IMPACT, so an A/B verdict can't be trusted. Validate a stable shift source with --cls-source, or reduce page variance.`;
  return entry;
}

function normalizeViewport(vp) {
  if (!vp || typeof vp !== 'object') return null;
  if (!Number.isFinite(vp.width) || !Number.isFinite(vp.height)) return null;
  const normalized = { width: vp.width, height: vp.height };
  if (Number.isFinite(vp.deviceScaleFactor)) {
    normalized.deviceScaleFactor = vp.deviceScaleFactor;
  }
  return normalized;
}

function compareViewportValues(left, right) {
  if (!left || !right) return { reason: 'missing-viewport', fields: ['viewport'] };
  const fields = ['width', 'height'];
  if (left.deviceScaleFactor != null && right.deviceScaleFactor != null) {
    fields.push('deviceScaleFactor');
  }
  const mismatched = fields.filter((field) => left[field] !== right[field]);
  return mismatched.length ? { reason: 'viewport-mismatch', fields: mismatched } : null;
}

function viewportIncomparability(baseline, treatment, baseline2 = null) {
  const baselineViewport = normalizeViewport(baseline.viewport);
  const treatmentViewport = normalizeViewport(treatment.viewport);
  const treatmentIssue = compareViewportValues(baselineViewport, treatmentViewport);
  if (treatmentIssue) {
    return {
      ...treatmentIssue,
      comparison: 'baseline-treatment',
      baselineViewport,
      treatmentViewport,
    };
  }

  if (baseline2) {
    const baseline2Viewport = normalizeViewport(baseline2.viewport);
    const baseline2Issue = compareViewportValues(baselineViewport, baseline2Viewport);
    if (baseline2Issue) {
      return {
        ...baseline2Issue,
        comparison: 'baseline-baseline2',
        baselineViewport,
        treatmentViewport,
        baseline2Viewport,
      };
    }
  }

  return null;
}

function evaluate({ baseline, treatment, baseline2 = null, clsSource = null, metrics, warmup, minSamples, maxRelSpread }) {
  const unknown = metrics.filter((m) => !METRICS.includes(m));
  if (unknown.length) {
    throw new Error(`Unknown metrics: ${unknown.join(', ')}. Allowed: ${METRICS.join(', ')}`);
  }
  const relOpts = {
    minSamples: typeof minSamples === 'number' ? minSamples : QUALITY_DEFAULTS.minSamples,
    maxRelSpread: maxRelSpread !== undefined ? maxRelSpread : QUALITY_DEFAULTS.maxRelSpread,
  };

  const targetLabels = [...metrics];
  if (clsSource) targetLabels.push(`CLS@${clsSource}`);
  const incomparable = viewportIncomparability(baseline, treatment, baseline2);
  if (incomparable) {
    return {
      schemaVersion: '1.0',
      tool: 'oracle.js',
      timestamp: new Date().toISOString(),
      baselineUrl: baseline.url,
      treatmentUrl: treatment.url,
      profile: treatment.profile || baseline.profile || null,
      viewport: incomparable.comparison === 'baseline-baseline2' ? incomparable.treatmentViewport : null,
      targetMetrics: targetLabels,
      clsSource: clsSource || undefined,
      aaGate: baseline2 ? true : undefined,
      warmup,
      runsBaseline: Math.max(0, (baseline.runs || []).length - warmup),
      runsTreatment: Math.max(0, (treatment.runs || []).length - warmup),
      metrics: [],
      verdict: 'UNRELIABLE',
      confidence: 'high',
      reason: 'launcher outputs are not comparable because their recorded viewports are missing or differ',
      incomparable,
      exitCode: EXIT_CODES.UNRELIABLE,
    };
  }

  const perMetric = [];
  for (const metric of metrics) {
    perMetric.push(compareSamples(
      metric,
      extractSamples(baseline, metric, warmup),
      extractSamples(treatment, metric, warmup),
      relOpts,
    ));
  }

  // Targeted CLS shift-source validation (--cls-source) — the clean signal on a
  // multi-source page. A stable source (e.g. a consent banner) validates; a
  // volatile one (e.g. a lazy content carousel) self-flags UNRELIABLE.
  if (clsSource) {
    const sourceLabel = `CLS@${clsSource}`;
    perMetric.push(compareSamples(
      'CLS',
      extractSourceSamples(baseline, clsSource, warmup),
      extractSourceSamples(treatment, clsSource, warmup),
      relOpts,
      { label: sourceLabel, source: clsSource },
    ));
  }

  // A/A noise-floor gate (--baseline2): control = baseline vs the second no-patch
  // baseline, computed per entry (whole-page metric or per-source) and applied.
  if (baseline2) {
    for (const entry of perMetric) {
      const control = entry.source
        ? compareSamples('CLS',
          extractSourceSamples(baseline, entry.source, warmup),
          extractSourceSamples(baseline2, entry.source, warmup),
          relOpts, { label: entry.metric, source: entry.source })
        : compareSamples(entry.metric,
          extractSamples(baseline, entry.metric, warmup),
          extractSamples(baseline2, entry.metric, warmup),
          relOpts);
      applyAaGate(entry, control);
    }
  }

  const overall = rollUp(perMetric, targetLabels);

  return {
    schemaVersion: '1.0',
    tool: 'oracle.js',
    timestamp: new Date().toISOString(),
    baselineUrl: baseline.url,
    treatmentUrl: treatment.url,
    profile: treatment.profile || baseline.profile || null,
    // The rendered viewport (spec 003-06), carried through from the launcher
    // outputs so a validate verdict states it. CLS score is viewport-relative,
    // so a baseline/treatment comparison is only valid at the same viewport.
    viewport: normalizeViewport(treatment.viewport) || normalizeViewport(baseline.viewport),
    targetMetrics: targetLabels,
    clsSource: clsSource || undefined,
    aaGate: baseline2 ? true : undefined,
    warmup,
    runsBaseline: Math.max(0, (baseline.runs || []).length - warmup),
    runsTreatment: Math.max(0, (treatment.runs || []).length - warmup),
    metrics: perMetric,
    verdict: overall,
    exitCode: EXIT_CODES[overall] != null ? EXIT_CODES[overall] : EXIT_CODES.ERROR,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); process.exit(0); }

  if (!args.baseline || !args.treatment) {
    process.stderr.write('Error: --baseline and --treatment are required.\n' + HELP);
    process.exit(EXIT_CODES.ERROR);
  }

  let baseline, treatment, baseline2 = null;
  try {
    baseline = readLauncherJson(args.baseline);
    treatment = readLauncherJson(args.treatment);
    if (args.baseline2) baseline2 = readLauncherJson(args.baseline2);
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message, phase: 'read' }) + '\n');
    process.exit(EXIT_CODES.ERROR);
  }

  let verdict;
  try {
    verdict = evaluate({
      baseline,
      treatment,
      baseline2,
      clsSource: args.clsSource,
      metrics: args.metrics,
      warmup: args.warmup,
      minSamples: args.minSamples,
      maxRelSpread: args.maxRelSpread,
    });
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message, phase: 'evaluate' }) + '\n');
    process.exit(EXIT_CODES.ERROR);
  }

  const json = JSON.stringify(verdict, null, 2);
  if (args.output) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
      fs.writeFileSync(args.output, json);
    } catch (err) {
      process.stderr.write(JSON.stringify({ error: err.message, phase: 'write-output' }) + '\n');
      process.exit(EXIT_CODES.ERROR);
    }
  } else {
    process.stdout.write(json + '\n');
  }

  process.exit(verdict.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err && err.message || String(err), phase: 'main' }) + '\n');
    process.exit(EXIT_CODES.ERROR);
  }
}

export {
  EXIT_CODES,
  parseArgs,
  extractSamples,
  extractSourceSamples,
  percentile,
  median,
  summarize,
  iqrOverlap,
  detectNoOp,
  compareMetric,
  compareSamples,
  applyAaGate,
  normalizeViewport,
  viewportIncomparability,
  rollUp,
  evaluate,
  manualReviewVerdict,
  verdictForClassification,
};
