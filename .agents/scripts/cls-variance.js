#!/usr/bin/env node

/**
 * CLS shift-source variance / stability report (ROADMAP V4).
 *
 * V1 made the *oracle* per-shift-source smart (`--cls-source`, A/A `--baseline2`),
 * but nothing on the diagnosis side told you WHICH shift source to target or that
 * a page's total CLS is noise-dominated — a human did that by hand on otempo. This
 * promotes the throwaway `loop-2026-06-10/analyze-variance.mjs` prototype into a
 * first-class, reusable report.
 *
 * Input: one or more multi-run launcher baseline JSONs (`{ runs: [{ cwv: { cls:
 * { value, shiftSources: [{ node, clsShare }] } } }] }`). Runs are POOLED across
 * all inputs — orchestrate captures a baseline (5 runs) and, on a noise-dominated
 * page, a 2nd baseline; pooling the two gives a firmer ≥10-run classification and
 * the 2nd baseline doubles as the oracle A/A control.
 *
 * Output (stdout JSON):
 *   - `sources[]`        — per shift-source (grouped by a stable cross-run
 *                          signature): clsShare distribution + a stable|volatile
 *                          classification.
 *   - `noiseFloor`       — range of total CLS across the pooled runs (the page's
 *                          run-to-run CLS noise).
 *   - `noiseDominated`   — noiseFloor exceeds MIN_IMPACT.CLS.delta, i.e. the
 *                          run-to-run drift is larger than the delta the oracle
 *                          would call actionable, so a total-CLS A/B can't be
 *                          trusted (validate a stable source instead).
 *   - `recommendedClsSource` — the dominant *stable* source's oracle token, ready
 *                          to pass to `oracle.js --cls-source`.
 *
 * Stability is two-gated, because neither gate alone is sufficient:
 *   1. PRESENCE — a source absent from ≥20% of runs is intermittent (volatile)
 *      regardless of how tight it is when present. (Catches otempo's
 *      `cmp-template-grid>article`, present 7/10, whose IQR sits under the CLS
 *      floor.)
 *   2. SPREAD   — `measure-quality.assessReliability` with the CLS abs floor 0.1:
 *      a source whose clsShare IQR is large in BOTH relative and absolute terms is
 *      too noisy to trust. (Catches `list__wrapper`, swinging 0 → 0.22.)
 *
 * The recommended `--cls-source` is re-validated under oracle's *substring-sum*
 * matching semantics (oracle sums every `shiftSources[].node` that `.includes()`
 * the token) — so the number the report recommends is the number the oracle will
 * actually measure, and a token whose substring-sum drags in a volatile sibling is
 * never recommended.
 *
 * Pure functions are exported for analyzers/skills; the `import.meta` CLI reads
 * files and prints the report.
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { assessReliability, percentile } from './measure-quality.js';
import { MIN_IMPACT } from './finding-schema.js';

// A source absent from more than (1 - PRESENCE_MIN) of runs is intermittent.
const PRESENCE_MIN = 0.8;
const DEFAULT_MIN_SAMPLES = 3;

// Layout/utility/grid/font classes that don't identify a component — dropped
// when building a source signature so the same logical source aligns across runs
// even when the captured ancestor chain varies in depth.
const UTILITY_CLASS = [
  /^aem-Grid/, // aem-Grid, aem-Grid--12, aem-GridColumn
  /^font-/, // font-lato, font-bold, …
  /^has-(desktop|mobile|tablet)-width$/,
  /^(default|cmp)$/,
  /^\d+$/, // bare column counts: 12
  /^\d+x\d/, // grid specs: 4x4x4
];
const isUtilityClass = (c) => UTILITY_CLASS.some((re) => re.test(c));

function round4(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

/** Meaningful (non-utility) class tokens of one `>`-separated selector segment. */
function segClasses(seg) {
  return (String(seg).match(/\.[A-Za-z0-9_-]+/g) || [])
    .map((c) => c.slice(1))
    .filter((c) => !isUtilityClass(c));
}

/**
 * Stable cross-run signature for a shift-source `node` selector: the last two
 * `>`-separated segments, reduced to their first meaningful class (or tag). The
 * launcher captures different ancestor depths run to run; the signature collapses
 * those to one key so a source can be tracked across runs.
 *
 * @param {string} node
 * @returns {string} e.g. "t004-cookie>cookies__container"
 */
function clsSourceSig(node) {
  const segs = String(node || '')
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segs.length) return '(unknown)';
  return segs
    .slice(-2)
    .map((seg) => {
      const classes = segClasses(seg);
      if (classes.length) return classes[0];
      const tag = seg.match(/^[a-z]+/i);
      return tag ? tag[0] : seg.slice(0, 12);
    })
    .join('>');
}

/**
 * The oracle `--cls-source` token for a signature: the leaf-most key. oracle
 * matches it as a `.includes()` substring against each `shiftSources[].node`.
 *
 * @param {string} sig
 * @returns {string}
 */
function oracleToken(sig) {
  const s = String(sig || '');
  const i = s.lastIndexOf('>');
  return i >= 0 ? s.slice(i + 1) : s;
}

// Normalize CLI/programmatic input to an array of launcher JSON objects.
function toInputs(inputs) {
  if (Array.isArray(inputs)) return inputs.filter(Boolean);
  if (inputs && typeof inputs === 'object') return [inputs];
  return [];
}

// Pool every run across all input launcher JSONs, preserving order.
function poolRuns(inputs) {
  const runs = [];
  for (const j of inputs) {
    if (j && Array.isArray(j.runs)) runs.push(...j.runs);
  }
  return runs;
}

function clsOf(run) {
  return run && run.cwv && run.cwv.cls ? run.cwv.cls : null;
}

// Per-run summed clsShare for every shiftSources[].node that `.includes(token)` —
// mirrors oracle.extractSourceSamples so the report's number == oracle's number.
function substringSumSamples(runs, token) {
  const tok = String(token || '').replace(/^[.\s]+/, '').trim();
  if (!tok) return [];
  return runs.map((run) => {
    const cls = clsOf(run);
    const sources = cls && Array.isArray(cls.shiftSources) ? cls.shiftSources : [];
    let sum = 0;
    for (const s of sources) {
      if (s && typeof s.node === 'string' && s.node.includes(tok) && Number.isFinite(s.clsShare)) {
        sum += s.clsShare;
      }
    }
    return sum;
  });
}

function distribution(vector) {
  const present = vector.filter((v) => v > 0).length;
  const sorted = vector.slice().sort((a, b) => a - b);
  const sum = vector.reduce((a, b) => a + b, 0);
  return {
    present,
    n: vector.length,
    min: round4(sorted[0] ?? 0),
    max: round4(sorted[sorted.length - 1] ?? 0),
    range: round4((sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0)),
    mean: round4(vector.length ? sum / vector.length : 0),
    median: round4(percentile(sorted, 50) ?? 0),
  };
}

/**
 * Classify a clsShare vector (length = pooled run count, 0 where the source was
 * absent that run) as stable or volatile via the two gates.
 */
function classify(vector, { minSamples }) {
  const dist = distribution(vector);
  const sufficient = dist.n >= minSamples;
  const presenceOk = dist.n > 0 && dist.present / dist.n >= PRESENCE_MIN;
  const rel = assessReliability(vector, { metric: 'CLS' });
  const stable = sufficient && presenceOk && rel.reliable;

  const reasons = [`present ${dist.present}/${dist.n}`];
  if (!sufficient) reasons.push(`too few runs (need ≥ ${minSamples})`);
  else if (!presenceOk) reasons.push('intermittent (absent in >20% of runs)');
  if (!rel.reliable && rel.relSpread != null) reasons.push(rel.reason);
  else if (rel.relSpread != null) reasons.push(`spread ${rel.relSpread}× median within tolerance`);

  return {
    ...dist,
    relSpread: rel.relSpread,
    stable,
    reason: reasons.join('; '),
  };
}

/**
 * Build the CLS variance / stability report from one or more launcher baselines.
 *
 * @param {object|object[]} inputs   launcher JSON(s); runs are pooled.
 * @param {object} [opts]
 * @param {number} [opts.minSamples=3]
 * @returns {object} the report (see module docstring).
 */
function analyzeClsVariance(inputs, opts = {}) {
  const minSamples = typeof opts.minSamples === 'number' ? opts.minSamples : DEFAULT_MIN_SAMPLES;
  const list = toInputs(inputs);
  const runs = poolRuns(list);
  const N = runs.length;
  const meta = list.find((j) => j && (j.url || j.profile)) || {};

  // ---- total CLS noise floor -------------------------------------------
  const totalValues = runs
    .map((r) => clsOf(r))
    .filter((c) => c && Number.isFinite(c.value))
    .map((c) => c.value);
  const tSorted = totalValues.slice().sort((a, b) => a - b);
  const noiseFloor =
    totalValues.length >= 2 ? round4(tSorted[tSorted.length - 1] - tSorted[0]) : 0;
  const minActionableImpact = MIN_IMPACT.CLS.delta;
  const noiseDominated = totalValues.length >= 2 && noiseFloor > minActionableImpact;

  // ---- per-source signature vectors ------------------------------------
  const sigMap = new Map(); // sig -> { vector, exampleNode }
  runs.forEach((run, i) => {
    const cls = clsOf(run);
    const sources = cls && Array.isArray(cls.shiftSources) ? cls.shiftSources : [];
    for (const s of sources) {
      if (!s || typeof s.node !== 'string' || !Number.isFinite(s.clsShare)) continue;
      const sig = clsSourceSig(s.node);
      if (!sigMap.has(sig)) sigMap.set(sig, { vector: new Array(N).fill(0), exampleNode: s.node });
      sigMap.get(sig).vector[i] += s.clsShare;
    }
  });

  const sources = [];
  for (const [sig, { vector, exampleNode }] of sigMap) {
    const c = classify(vector, { minSamples });
    sources.push({
      sig,
      token: oracleToken(sig),
      exampleNode,
      samples: vector.map(round4),
      present: c.present,
      n: c.n,
      min: c.min,
      max: c.max,
      range: c.range,
      mean: c.mean,
      median: c.median,
      relSpread: c.relSpread,
      stable: c.stable,
      reason: c.reason,
    });
  }
  sources.sort((a, b) => b.mean - a.mean);

  // ---- recommended --cls-source ----------------------------------------
  // Dominant stable source whose oracle token, re-measured under oracle's
  // substring-sum semantics, is ITSELF stable (so the recommended number is the
  // number oracle will produce, and a token that drags in a volatile sibling is
  // rejected).
  let recommendation = null;
  for (const src of sources.filter((s) => s.stable)) {
    const sumVector = substringSumSamples(runs, src.token);
    const c = classify(sumVector, { minSamples });
    if (c.stable) {
      recommendation = {
        token: src.token,
        sig: src.sig,
        exampleNode: src.exampleNode,
        present: c.present,
        n: c.n,
        mean: c.mean,
        min: c.min,
        max: c.max,
        range: c.range,
        stable: true,
        reason: c.reason,
      };
      break;
    }
  }

  const stableSources = sources.filter((s) => s.stable).map((s) => s.sig);
  const volatileSources = sources.filter((s) => !s.stable).map((s) => s.sig);

  const summary = buildSummary({
    N,
    minSamples,
    noiseFloor,
    minActionableImpact,
    noiseDominated,
    recommendation,
    stableSources,
    volatileSources,
  });

  return {
    tool: 'cls-variance',
    schemaVersion: '1.0',
    url: meta.url || null,
    profile: meta.profile || null,
    runs: N,
    insufficientRuns: N < minSamples,
    minActionableImpact,
    totalCls: {
      values: totalValues.map(round4),
      min: round4(tSorted[0] ?? 0),
      max: round4(tSorted[tSorted.length - 1] ?? 0),
      range: noiseFloor,
      median: round4(percentile(tSorted, 50) ?? 0),
    },
    noiseFloor,
    noiseDominated,
    recommendedClsSource: recommendation ? recommendation.token : null,
    recommendation,
    stableSources,
    volatileSources,
    sources,
    summary,
  };
}

function buildSummary(s) {
  if (s.N < s.minSamples) {
    return `insufficient runs (${s.N} < ${s.minSamples}) — capture more baseline runs before classifying CLS shift sources`;
  }
  const parts = [
    `${s.N} runs; total-CLS noise floor ${s.noiseFloor} (MIN_ACTIONABLE_IMPACT ${s.minActionableImpact})`,
    `${s.stableSources.length} stable / ${s.volatileSources.length} volatile shift source(s)`,
  ];
  if (s.noiseDominated) {
    parts.push(
      s.recommendation
        ? `total CLS is NOISE-DOMINATED — validate --cls-source="${s.recommendation.token}" (stable ~${s.recommendation.mean}) instead of total CLS, with an A/A --baseline2`
        : 'total CLS is NOISE-DOMINATED and no stable shift source dominates — block/stub the variable content or interleave runs',
    );
  } else if (s.recommendation) {
    parts.push(`dominant stable source: --cls-source="${s.recommendation.token}" (~${s.recommendation.mean})`);
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const files = [];
  let minSamples = DEFAULT_MIN_SAMPLES;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-samples') minSamples = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') files.length = 0;
    else if (!a.startsWith('--')) files.push(a);
  }
  if (!files.length) {
    process.stderr.write(
      'Usage: node .agents/scripts/cls-variance.js <baseline.json> [baseline-2.json ...] [--min-samples N]\n' +
        '  Pools all runs and reports per-shift-source clsShare stability, the total-CLS\n' +
        '  noise floor, and a recommended oracle --cls-source target.\n',
    );
    process.exit(2);
  }
  const inputs = [];
  for (const f of files) {
    try {
      inputs.push(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), f), 'utf8')));
    } catch (err) {
      process.stderr.write(`Error reading ${f}: ${err.message}\n`);
      process.exit(1);
    }
  }
  const report = analyzeClsVariance(inputs, { minSamples });
  process.stderr.write(report.summary + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

export { analyzeClsVariance, clsSourceSig, oracleToken, PRESENCE_MIN };
