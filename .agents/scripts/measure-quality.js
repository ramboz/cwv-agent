#!/usr/bin/env node

/**
 * Measurement-reliability assessor (ROADMAP G2).
 *
 * The the news-site case run exposed a silent failure: a heavy ad page under
 * mobile-slow4g-4xcpu yielded 0–1 usable web-vitals samples, yet the oracle
 * happily produced a verdict from a single reading (n=1 → zero-width IQR →
 * spurious VALIDATED/INCONCLUSIVE). The fix is to make "the measurement itself
 * can't be trusted" an EXPLICIT outcome instead of a confident-looking number.
 *
 * `assessReliability` is a pure per-metric gate used by:
 *   - oracle.js     — emits an `UNRELIABLE` verdict (exit 7) when either side
 *                     of a comparison is untrustworthy, instead of comparing.
 *   - launcher.js   — `--max-runs` adaptive mode runs until every target metric
 *                     is reliable (or the cap hits).
 *
 * Two gates:
 *   1. Sample count (primary, robust): n < `minSamples` → unreliable. CWV lab
 *      readings are noisy; a 1–2 run comparison is not a measurement.
 *   2. Spread (secondary, conservative): a metric is "too noisy" only when its
 *      IQR is large in BOTH relative AND absolute terms —
 *      IQR / |median| > `maxRelSpread` AND IQR > `absSpreadFloor[metric]`.
 *      Requiring meaningful absolute spread avoids false-positiving fast pages,
 *      where a cold-run-1 outlier makes relative spread large but the absolute
 *      swing is trivial (e.g. example.com LCP 220ms ± 190ms). It fires on
 *      genuine ad/3p variance (the news-site case LCP swinging multiple seconds).
 *
 * Diagnostics → stderr, JSON → stdout. `require.main` CLI assesses a launcher
 * output file's per-metric reliability.
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const DEFAULTS = Object.freeze({
  minSamples: 3,
  maxRelSpread: 0.6, // IQR is 60% of the median ⇒ too noisy to trust
});

/**
 * Absolute IQR floor per metric: the spread gate only fires when the IQR
 * exceeds this. Generous on purpose — below this, run-to-run swing is too small
 * to matter regardless of how large it looks relative to a tiny median (cold
 * run-1 jitter on a fast page). Above it, combined with a high relative spread,
 * the measurement is genuinely noisy (ad/3p variance). Units: ms, except CLS.
 */
const ABS_SPREAD_FLOOR = Object.freeze({
  LCP: 1000, FCP: 800, INP: 150, TTFB: 500, TBT: 300, SI: 1000, CLS: 0.1,
});

function round4(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Number(n.toFixed(4));
}

// Linear-interpolated percentile (type-7), matches oracle.js. `sorted` ascending.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Assess whether a set of metric samples is reliable enough to compare/act on.
 *
 * @param {number[]} samples
 * @param {object} [opts]
 * @param {string} [opts.metric]        Metric name — selects the spread floor.
 * @param {number} [opts.minSamples=3]  Minimum valid samples to be reliable.
 * @param {number|null} [opts.maxRelSpread=0.6] Max IQR/|median|; null disables the spread gate.
 * @param {number} [opts.spreadFloor]   Override the per-metric spread floor.
 * @returns {{ reliable: boolean, n: number, relSpread: number|null, reason: string }}
 */
function assessReliability(samples, opts) {
  const o = opts || {};
  const minSamples = typeof o.minSamples === 'number' ? o.minSamples : DEFAULTS.minSamples;
  const maxRelSpread = o.maxRelSpread !== undefined ? o.maxRelSpread : DEFAULTS.maxRelSpread;
  const list = (Array.isArray(samples) ? samples : []).filter(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );
  const n = list.length;

  if (n < minSamples) {
    return {
      reliable: false,
      n,
      relSpread: null,
      reason: `only ${n} valid sample${n === 1 ? '' : 's'}; need ≥ ${minSamples}`,
    };
  }

  const sorted = list.slice().sort((a, b) => a - b);
  const med = percentile(sorted, 50);
  const absIqr = percentile(sorted, 75) - percentile(sorted, 25);

  // Absolute IQR floor below which run-to-run swing is too small to matter
  // (cold run-1 jitter on a fast page), so the relative gate is skipped.
  const absFloor =
    typeof o.spreadFloor === 'number'
      ? o.spreadFloor
      : (o.metric && ABS_SPREAD_FLOOR[o.metric] != null ? ABS_SPREAD_FLOOR[o.metric] : 0);

  let relSpread = null;
  if (maxRelSpread != null && Math.abs(med) > 0) {
    relSpread = round4(absIqr / Math.abs(med));
    // "Too noisy" requires BOTH a high relative spread AND a meaningful
    // absolute swing — so a fast page with tiny absolute jitter isn't punished.
    if (relSpread > maxRelSpread && absIqr > absFloor) {
      return {
        reliable: false,
        n,
        relSpread,
        reason: `IQR ${round4(absIqr)} is ${relSpread}× the median (> ${maxRelSpread}) and exceeds the ${absFloor} floor — measurement too noisy (ad/3p variance?)`,
      };
    }
  }

  return { reliable: true, n, relSpread, reason: '' };
}

/**
 * Assess every target metric's reliability across a launcher output's runs.
 * Convenience for the launcher's adaptive-runs loop and the CLI.
 *
 * @param {{ runs: Array }} launcherJson
 * @param {string[]} metrics
 * @param {object} [opts] — forwarded to assessReliability (minSamples, maxRelSpread).
 * @returns {{ allReliable: boolean, perMetric: Record<string, ReturnType<typeof assessReliability>> }}
 */
function assessLauncherOutput(launcherJson, metrics, opts) {
  const runs = launcherJson && Array.isArray(launcherJson.runs) ? launcherJson.runs : [];
  const perMetric = {};
  let allReliable = true;
  for (const metric of metrics) {
    const key = metric.toLowerCase();
    const samples = [];
    for (const r of runs) {
      const m = r && r.cwv && r.cwv[key];
      if (m && typeof m.value === 'number' && Number.isFinite(m.value)) samples.push(m.value);
    }
    const rel = assessReliability(samples, { ...opts, metric });
    perMetric[metric] = rel;
    if (!rel.reliable) allReliable = false;
  }
  return { allReliable, perMetric };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file || argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(
      'Usage: node .agents/scripts/measure-quality.js <launcher-output.json> [--metrics LCP,CLS,INP] [--min-samples N]\n',
    );
    process.exit(file ? 0 : 2);
  }
  const mIdx = argv.indexOf('--metrics');
  const metrics = mIdx >= 0 && argv[mIdx + 1]
    ? argv[mIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    : ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];
  const sIdx = argv.indexOf('--min-samples');
  const minSamples = sIdx >= 0 ? parseInt(argv[sIdx + 1], 10) : DEFAULTS.minSamples;

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(`Error reading ${file}: ${err.message}\n`);
    process.exit(1);
  }
  const result = assessLauncherOutput(doc, metrics, { minSamples });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.allReliable ? 0 : 7);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

export {
  DEFAULTS,
  ABS_SPREAD_FLOOR,
  assessReliability,
  assessLauncherOutput,
  percentile,
};
