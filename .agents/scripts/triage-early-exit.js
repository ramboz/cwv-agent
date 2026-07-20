/**
 * Triage early-exit decision helper.
 *
 * Canonical reference: .agents/skills/cwv-triage.md Step 6b.
 *
 * Pure function. Given per-form-factor field p75 readings (from CrUX and/or
 * RUM), decide whether the URL is "field-already-passing" — i.e. every
 * queried form factor shows every target metric strictly below the GOOD
 * threshold, measured from real field data.
 *
 * This is used by the triage skill (invoked by the LLM) to decide whether
 * to set envelope `status: "passing"` — which in turn causes downstream
 * skills (cwv-analyze, cwv-orchestrate) to refuse to start unless
 * `--force` is passed. Rationale: a field-green page has zero headroom
 * below GOOD, so running the expensive diagnose/fix/validate loop on it
 * is pure compute waste — even a VALIDATED lab delta cannot translate
 * into field improvement.
 *
 * GOOD thresholds (web.dev CWV definitions — same on every form factor):
 *   LCP ≤ 2500ms, CLS ≤ 0.1, INP ≤ 200ms.
 *
 * Usage:
 *   import { decideEarlyExit, buildPassingEnvelope, GOOD_THRESHOLDS }
 *     from './triage-early-exit.js';
 *   const dec = decideEarlyExit({
 *     formFactorSignals: {
 *       PHONE:   { source: 'crux', metrics: { LCP: 1393, CLS: 0.02, INP: 106 } },
 *       DESKTOP: { source: 'crux', metrics: { LCP: 1120, CLS: 0.01, INP: 88  } },
 *     },
 *     targetMetrics: ['LCP', 'CLS', 'INP'],
 *   });
 *   if (dec.passing) {
 *     envelope.status = 'passing';
 *     envelope.passing = dec.passing;
 *   }
 */


const GOOD_THRESHOLDS = Object.freeze({ LCP: 2500, CLS: 0.1, INP: 200 });

/**
 * `source` values that count as real field data. PSI is lab (single-location
 * Google-owned runner) and never justifies early-exit.
 */
const FIELD_SOURCES = new Set(['crux', 'rum']);

/**
 * Compute per-metric pressure for one form factor's metric block.
 * Missing metric values are treated as "not measured" — NOT as 0 (which
 * would falsely read as "perfect"). The caller decides whether to require
 * presence or tolerate absence per metric.
 *
 * @param {Record<string, number|null|undefined>} metrics
 * @returns {{ maxPressure: number, perMetric: Record<string, number|null> }}
 */
function computePressure(metrics) {
  const perMetric = {};
  let maxPressure = 0;
  for (const m of Object.keys(GOOD_THRESHOLDS)) {
    const v = metrics ? metrics[m] : null;
    if (typeof v !== 'number' || Number.isNaN(v)) {
      perMetric[m] = null;
      continue;
    }
    const p = v / GOOD_THRESHOLDS[m];
    perMetric[m] = p;
    if (p > maxPressure) maxPressure = p;
  }
  return { maxPressure, perMetric };
}

/**
 * Decide whether to early-exit.
 *
 * @param {object} input
 * @param {Record<string, { source: string, metrics: Record<string, number|null|undefined> }>} input.formFactorSignals
 *   Keyed by form factor: PHONE | DESKTOP | TABLET. Each entry carries the
 *   source ('crux' | 'rum' | 'psi') and the p75 metric block.
 * @param {string[]} [input.targetMetrics=['LCP','CLS','INP']]
 *   Metrics the page is being audited against. Only these are evaluated.
 * @param {Record<string, { source: string, metrics: Record<string, number> }>} [input.cruxOverride]
 *   When the "primary" signal is RUM but CrUX is also available and disagrees
 *   (worse — NI/Poor), pass the CrUX block here. The rule is: RUM-good +
 *   CrUX-not-good → do NOT early-exit (CrUX's 28-day window is authoritative
 *   at the aggregate level; RUM's fresher/shorter window may be masking the
 *   ramp of a recent regression). Optional.
 *
 * @returns {{
 *   passing: null | {
 *     reason: 'field-already-good',
 *     checked: string[],
 *     byFormFactor: Record<string, { source: string, maxPressure: number } & Record<string, number>>,
 *     thresholds: typeof GOOD_THRESHOLDS,
 *   },
 *   reasonIfNotPassing: string,
 * }}
 */
function decideEarlyExit(input) {
  const { formFactorSignals, targetMetrics = ['LCP', 'CLS', 'INP'], cruxOverride } = input || {};
  if (!formFactorSignals || typeof formFactorSignals !== 'object') {
    return { passing: null, reasonIfNotPassing: 'no form-factor signals supplied' };
  }

  const ffKeys = Object.keys(formFactorSignals);
  if (ffKeys.length === 0) {
    return { passing: null, reasonIfNotPassing: 'no form factors queried' };
  }

  const byFormFactor = {};

  for (const ff of ffKeys) {
    const block = formFactorSignals[ff];
    if (!block || typeof block !== 'object') {
      return { passing: null, reasonIfNotPassing: `malformed block for ${ff}` };
    }
    // PSI-only case — do NOT early-exit. PSI is lab, not field ground truth.
    if (!FIELD_SOURCES.has(block.source)) {
      return {
        passing: null,
        reasonIfNotPassing:
          `source "${block.source}" on ${ff} is not field data (CrUX/RUM); ` +
          `early-exit requires real field signal`,
      };
    }

    const { maxPressure, perMetric } = computePressure(block.metrics);

    // Every target metric must be strictly < 1.0 pressure.
    for (const m of targetMetrics) {
      if (!Object.hasOwn(GOOD_THRESHOLDS, m)) {
        // Metric not in the GOOD threshold table (e.g. FCP/TTFB) — be
        // conservative and refuse to early-exit. The rule is defined for
        // LCP/CLS/INP only.
        return {
          passing: null,
          reasonIfNotPassing: `target metric "${m}" has no GOOD threshold for early-exit`,
        };
      }
      const p = perMetric[m];
      if (p === null) {
        // Missing metric reading. INP is commonly absent (no interactions in
        // the window). Treat absence as "not measured," NOT as good — refuse
        // to early-exit unless this is INP AND LCP+CLS are both present and
        // GOOD (common, and still safe because INP missing means no users
        // reported pain on it).
        if (m === 'INP') {
          const lcp = perMetric.LCP;
          const cls = perMetric.CLS;
          if (lcp === null || cls === null || lcp >= 1.0 || cls >= 1.0) {
            return {
              passing: null,
              reasonIfNotPassing:
                `INP missing on ${ff} and LCP/CLS are not both GOOD — refuse to early-exit`,
            };
          }
          // INP-absent-but-LCP+CLS-GOOD: allow, but record explicitly.
          continue;
        }
        return {
          passing: null,
          reasonIfNotPassing: `${m} p75 missing on ${ff} — treat as not-measured, refuse to early-exit`,
        };
      }
      if (p >= 1.0) {
        return {
          passing: null,
          reasonIfNotPassing: `${m} pressure ${p.toFixed(3)} >= 1.0 on ${ff}`,
        };
      }
    }

    // RUM vs CrUX disagreement: if this block is RUM-good but cruxOverride
    // shows CrUX is NI/Poor on the same form factor, refuse to early-exit.
    if (block.source === 'rum' && cruxOverride && cruxOverride[ff]) {
      const crux = cruxOverride[ff];
      if (FIELD_SOURCES.has(crux.source)) {
        const { maxPressure: cruxMax } = computePressure(crux.metrics);
        if (cruxMax >= 1.0) {
          return {
            passing: null,
            reasonIfNotPassing:
              `RUM is GOOD on ${ff} but CrUX max-pressure ${cruxMax.toFixed(3)} ≥ 1.0 — CrUX is authoritative at 28d`,
          };
        }
      }
    }

    const entry = { source: block.source, maxPressure };
    for (const m of targetMetrics) {
      const v = block.metrics ? block.metrics[m] : undefined;
      if (typeof v === 'number') entry[m] = v;
    }
    byFormFactor[ff] = entry;
  }

  return {
    passing: {
      reason: 'field-already-good',
      checked: [...targetMetrics],
      byFormFactor,
      thresholds: { ...GOOD_THRESHOLDS },
    },
    reasonIfNotPassing: '',
  };
}

/**
 * Build a passing envelope. Convenience for triage.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.recommendedFormFactor
 * @param {string} opts.recommendedProfile
 * @param {object} opts.passing
 * @param {string} [opts.timestamp]
 * @param {Array}  [opts.findings=[]]
 */
function buildPassingEnvelope(opts) {
  return {
    schemaVersion: '1.0',
    skill: 'cwv-triage',
    url: opts.url,
    timestamp: opts.timestamp || new Date().toISOString(),
    status: 'passing',
    recommendedFormFactor: opts.recommendedFormFactor,
    recommendedProfile: opts.recommendedProfile,
    passing: opts.passing,
    findings: opts.findings || [],
  };
}

export {
  GOOD_THRESHOLDS,
  FIELD_SOURCES,
  decideEarlyExit,
  buildPassingEnvelope,
  computePressure,
};
