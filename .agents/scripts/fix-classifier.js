#!/usr/bin/env node

/**
 * fix-classifier.js — the fix-classification gate (slice 016-01, the keystone
 * of spec 016 / ADR-0016 "workbench owns AEM byte production").
 *
 * Given a `patches.json` (or a fix list) + the detected stack, assign every
 * proposed fix a Class and a recommended validate route, emitted as a
 * phase-interface artifact (`classification.json`, ADR-0012) the operator and
 * the downstream Mode-A/B slices (016-03…06) consume BEFORE spending any
 * validation runs.
 *
 *   - Class 1 (generic-mutation)   → route `mode-a`             (ASV splice+measure)
 *   - Class 2 (delta-splice)       → route `delta-splice`       (autonomous publish)
 *   - Class 3-clientlib            → route `local-build-modeb`  (validates now, local build)
 *   - Class 3-htl / architectural  → route `producer-required`  (guidance-only)
 *
 * The classification LOGIC is a PURE function (`classifyFix`) that consumes an
 * ALREADY-RESOLVED 016-07 attribution result (or null) — it performs NO I/O.
 * The orchestrator (`classifyFixes`) resolves attribution per fix (only when a
 * rule needs it) via an INJECTABLE async `attribute` fn, calls `classifyFix`,
 * and returns the entry list + an operator summary. The default `attribute`
 * wires 016-07's `readClientlib`; tests stub it, so the classifier never touches
 * the network.
 *
 * ---------------------------------------------------------------------------
 * RULES (encoded EXACTLY per slice-01 ACs; the 2b/2c/2d narrowings are the
 * 016-09 spike go/no-go — Class 2 = CLS-only for autonomous publish;
 * absolute-timing gated on attributed+reservable source; architectural
 * entanglement and unattributed source both escalate).
 * ---------------------------------------------------------------------------
 *
 *   Base (AC 2):
 *     op ∈ {attribute, resource-hint (preload/fetchpriority), meta, defer, alt}
 *        → Class 1 / generic / mode-a
 *     CSS add/override (incl. an "override-clientlib" recommendation, or a
 *        rewriteBody injecting a <style>/CSS rule)
 *        → Class 2 / delta / delta-splice
 *     a clientlib change whose effect is order/blocking-dependent
 *        → Class 3 / clientlib / local-build-modeb
 *     a structural DOM-shape change under /apps/**\/*.html
 *        → Class 3 / htl / producer-required
 *
 *   Metric class: CLS is distribution-shift; LCP/TTFB/INP/FCP are absolute-timing;
 *     an `unknown` metric is treated as absolute-timing (conservative — no CLS
 *     license without a known CLS metric).
 *
 *   2b (metric-aware, as amended by spec 017): a would-be Class-2 fix on CLS keeps
 *     Class 2 (metricGate `cls-ok`). On absolute-timing it is Class 2 ONLY IF
 *     attribution is `attributed` AND `structuralRole === 'reservable'` (metricGate
 *     `absolute-timing-cleared` — publishable; the ADR-0003 3-arm interception-
 *     neutrality probe cleared in spec 017, so this is no longer diagnostic-only);
 *     otherwise it escalates to Class 3 producer-required (the DM-resize pattern).
 *     Class 1 / Class 3 entries carry metricGate `n/a`.
 *
 *   2c (entanglement, ANY metric): if attribution reports
 *     `structuralRole === 'order-dependent'` the fix escalates to Class 3
 *     producer-required regardless of metricGate — even a CLS fix (the zepbound
 *     section-gating hole). A fix is Class 2 only when attribution is `attributed`
 *     AND reservable.
 *
 *   2d (unattributed = non-confirmation): if attribution is
 *     `readable-but-unattributed` the fix does NOT get the Class-2 route and
 *     escalates to the highest applicable class with rationale `source-unattributed`.
 *
 *   AC 3 (ambiguous/unknown op): classify to the HIGHEST applicable class with a
 *     typed reason — never silently Class 1.
 *
 *   Note: a Class-2 fix on CLS (`cls-ok`) does NOT require attribution to be
 *   present — CLS delta-splice is licensed. But if attribution IS present and says
 *   order-dependent (2c) or unattributed (2d), it still escalates. Absolute-timing
 *   REQUIRES attribution to grant Class 2 (2b).
 *
 * Zero runtime dependencies beyond Node built-ins + local modules. Diagnostics →
 * stderr; machine output (JSON) → the emitted artifact + stdout; `require.main`
 * guard — repo convention.
 *
 * CLI:
 *   node fix-classifier.js --patches <p> [--findings <f>] --repo <root> [--output <o>]
 *
 * Module API:
 *   import { classifyFix, classifyFixes, buildClassification } from './fix-classifier.js';
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { detectStack } from './source-mapper.js';

// --------------------------------------------------------------------------
// Metric taxonomy (pure)
// --------------------------------------------------------------------------

// CLS is the only distribution-shift metric; everything else (LCP/TTFB/INP/FCP)
// is absolute-timing. An unknown metric is treated as absolute-timing — the
// conservative default (no CLS license without a known CLS metric).

/**
 * Metric class from a metric string.
 * @param {string} metric
 * @returns {'distribution-shift'|'absolute-timing'}
 */
function metricClass(metric) {
  const m = String(metric || '').trim().toUpperCase();
  if (m === 'CLS') return 'distribution-shift';
  return 'absolute-timing'; // includes LCP/TTFB/INP/FCP AND unknown (conservative)
}

// --------------------------------------------------------------------------
// Op taxonomy (pure)
// --------------------------------------------------------------------------

// Class-1 ops: generic mutations ASV Mode A can splice+measure directly —
// attribute edits, resource hints, meta, defer, alt. Patch-type synonyms
// (preloads/markup/requestHeaders/responseHeaders) map here too.
const CLASS1_OPS = new Set([
  'attribute', 'attr', 'markup',
  'preload', 'preloads', 'fetchpriority', 'resource-hint', 'resourcehint',
  'meta',
  'defer', 'async',
  'alt',
  'requestheaders', 'responseheaders',
]);

// Class-2 ops: an added/overridden CSS rule (delta-splice-able). Includes the
// selector-resolver "override-clientlib" recommendation and a rewriteBody that
// injects a <style>/CSS rule (see opIsCssDelta for the rewriteBody nuance).
const CLASS2_OPS = new Set([
  'css-override', 'cssoverride', 'css-add', 'cssadd', 'css',
  'override-clientlib', 'overrideclientlib',
]);

// Class-3-clientlib ops: a clientlib change whose effect is order/blocking-
// dependent (reorder, split a render-blocking monolith, move a loader) — must
// go through a local Mode-B build, cannot be a pure delta splice.
const CLASS3_CLIENTLIB_OPS = new Set([
  'clientlib-reorder', 'clientlibreorder',
  'clientlib-split', 'clientlibsplit',
  'clientlib-move', 'clientlibmove',
  'block', // moving a loader into loadDelayed reorders execution
  'reorder',
]);

// Class-3-htl ops: a structural DOM-shape change that only the producer can make
// (an HTL/template restructure under /apps/**\/*.html).
const CLASS3_HTL_OPS = new Set([
  'htl-structural', 'htlstructural', 'htl', 'template-structural', 'dom-structural',
]);

function normOp(op) {
  return String(op || '').trim().toLowerCase();
}

/**
 * True when the op is a CSS add/override delta. A `rewriteBody` op only qualifies
 * when it injects a <style>/CSS rule (details.injects === 'style' or a css hint);
 * an arbitrary body rewrite is NOT a delta-shaped CSS change.
 * @param {string} op        normalised op
 * @param {object} details   fix.details (optional)
 * @returns {boolean}
 */
function opIsCssDelta(op, details) {
  if (CLASS2_OPS.has(op)) return true;
  if (op === 'rewritebody' || op === 'rewrite-body') {
    const d = details || {};
    const injects = String(d.injects || d.inject || '').toLowerCase();
    return injects === 'style' || injects === 'css' || d.css === true || d.style === true;
  }
  return false;
}

/**
 * True when a selector/target points at HTL under /apps/**\/*.html — the
 * producer-only structural surface.
 * @param {string} selector
 * @returns {boolean}
 */
function targetsAppsHtl(selector) {
  const s = String(selector || '');
  return /(^|\/)apps\/.+\.html($|[?#])/i.test(s);
}

// --------------------------------------------------------------------------
// The pure classifier (AC 1/2/2b/2c/2d/3)
// --------------------------------------------------------------------------

// Route + subclass presets per class, so the mapping stays single-sourced.
const CLASS1 = { class: 1, subclass: 'generic', route: 'mode-a' };
const CLASS2 = { class: 2, subclass: 'delta', route: 'delta-splice' };
const CLASS3_CLIENTLIB = { class: 3, subclass: 'clientlib', route: 'local-build-modeb' };
const CLASS3_HTL = { class: 3, subclass: 'htl', route: 'producer-required' };
// Escalations from 2b/2c/2d/AC-3 are architecturally producer-required: same
// route + guidance-only bucket as htl, but the subclass records that the
// escalation was architectural (entangled / unattributed / unconfirmed) rather
// than a literal HTL restructure.
const CLASS3_ARCH = { class: 3, subclass: 'architectural', route: 'producer-required' };

/**
 * Classify a single fix. PURE — consumes an already-resolved 016-07 attribution
 * result (or null); performs no I/O.
 *
 * @param {object} fix
 * @param {string}   [fix.id]
 * @param {string}   fix.op                    the proposed op / patch type.
 * @param {string}   fix.metric                the target metric (CLS/LCP/…; may be 'unknown').
 * @param {string}   [fix.selector]            selector / target (used for /apps HTL detection).
 * @param {string}   [fix.implicatedClientlibUrl] the served clientlib the symptom lives in.
 * @param {object}   [fix.details]             op-specific detail (e.g. rewriteBody injects).
 * @param {object|null} [fix.attribution]      016-07 result (attributed / readable-but-
 *                                             unattributed / unreadable) or null.
 * @returns {{id?:string, class:1|2|3, subclass:string, route:string,
 *            metricGate:'cls-ok'|'absolute-timing-cleared'|'n/a', rationale:string}}
 *   metricGate: `cls-ok` (CLS distribution-shift delta — publishable) and
 *   `absolute-timing-cleared` (LCP/TTFB/INP delta, attribution-confirmed — publishable
 *   since spec 017 cleared the ADR-0003 interception-neutrality probe) are BOTH
 *   publishable; `n/a` is Class 1/3. (The pre-017 `absolute-timing-gated`
 *   diagnostic-only value is retired — the gate was lifted.)
 */
function classifyFix(fix) {
  const {
    id,
    op,
    metric,
    selector,
    details,
    attribution = null,
  } = fix || {};

  const o = normOp(op);
  const mClass = metricClass(metric);
  const emit = (preset, metricGate, rationale) => ({
    ...(id !== undefined ? { id } : {}),
    class: preset.class,
    subclass: preset.subclass,
    route: preset.route,
    metricGate,
    rationale,
  });

  // ---- Class 3-htl: structural DOM-shape change under /apps/**\/*.html ------
  // Checked first for a genuinely structural op; a structural op that also names
  // an apps HTL is producer-required regardless of anything else.
  if (CLASS3_HTL_OPS.has(o) || (o && targetsAppsHtl(selector) && CLASS3_HTL_OPS.has(o))) {
    return emit(CLASS3_HTL, 'n/a',
      `structural DOM-shape change under /apps/**/*.html — only the producer can restructure the template (op "${op}")`);
  }
  // Any op explicitly declared structural-under-apps escalates to htl.
  if (CLASS3_HTL_OPS.has(o)) {
    return emit(CLASS3_HTL, 'n/a', `structural HTL change (op "${op}") — producer-required`);
  }

  // ---- Class 3-clientlib: order/blocking-dependent clientlib change ---------
  if (CLASS3_CLIENTLIB_OPS.has(o)) {
    return emit(CLASS3_CLIENTLIB, 'n/a',
      `clientlib change whose effect is order/blocking-dependent (op "${op}") — needs a local Mode-B build, not a pure delta splice`);
  }

  // ---- Class 1: generic mutation (ASV Mode A) -------------------------------
  if (CLASS1_OPS.has(o)) {
    return emit(CLASS1, 'n/a', `generic mutation (op "${op}") — ASV Mode A can splice + measure directly`);
  }

  // ---- Class 2 candidate: CSS add/override delta ----------------------------
  if (opIsCssDelta(o, details)) {
    return classifyCssDelta({ id, op, metric, mClass, attribution, emit });
  }

  // ---- AC 3: ambiguous / unknown op → HIGHEST applicable class --------------
  // Never silently Class 1. Default to producer-required with a typed reason.
  return emit(CLASS3_ARCH, 'n/a',
    `ambiguous/unknown op "${op}" — classified to the highest applicable class (producer-required) per AC 3 (never silently Class 1)`);
}

/**
 * Resolve the Class-2 candidate (a CSS add/override delta) through the metric-
 * aware 2b / entanglement 2c / unattributed 2d narrowings.
 * @returns the classified entry.
 */
function classifyCssDelta({ metric, mClass, attribution, emit }) {
  const outcome = attribution && attribution.outcome;
  const role = attribution && attribution.structuralRole;

  // 2d — readable-but-unattributed is NON-confirmation: escalate, highest class.
  if (outcome === 'readable-but-unattributed') {
    return emit(CLASS3_ARCH, 'n/a',
      `source-unattributed: 016-07 read the bytes but found no owning source region (${attribution.reason || 'vendor-built / not-in-git'}) — non-confirmation, escalated to producer-required (rule 2d)`);
  }

  // 2c — architectural entanglement: an order-dependent symptom is Class 3 for
  // ANY metric (the zepbound section-gating / loadEager / hydration-order hole),
  // even when it presents as a single reservable selector.
  if (outcome === 'attributed' && role === 'order-dependent') {
    return emit(CLASS3_ARCH, 'n/a',
      `order-dependent/architecturally-entangled symptom (rule 2c) — the deployable form is not a single reservable rule; escalated to producer-required regardless of metric (${metric})`);
  }

  // Attribution present but neither attributed-reservable nor a recognised
  // escalation (e.g. `unreadable`, or attributed-but-unknown-role): treat as a
  // failure to confirm — escalate (AC 3 default-to-highest).
  const confirmedReservable = outcome === 'attributed' && role === 'reservable';

  // CLS (distribution-shift): delta-splice is licensed → Class 2 cls-ok. This
  // does NOT require attribution to be present; but if attribution WAS present it
  // has already been vetted for 2c/2d above.
  if (mClass === 'distribution-shift') {
    if (attribution && !confirmedReservable && outcome !== undefined) {
      // Attribution present and it neither confirms reservable nor matched 2c/2d
      // (e.g. unreadable / unknown role) → do not grant Class 2 blindly.
      return emit(CLASS3_ARCH, 'n/a',
        `CLS delta but source-attribution did not confirm a single reservable rule (outcome ${outcome}, role ${role}) — escalated to producer-required (AC 3)`);
    }
    return emit(CLASS2, 'cls-ok',
      'CLS (distribution-shift) delta-splice — autonomous publish licensed per 016-09 (rule 2b, metricGate cls-ok)');
  }

  // Absolute-timing (LCP/TTFB/INP/FCP or unknown): Class 2 ONLY IF attribution
  // confirms a delta-shaped deployable form (attributed + reservable). Otherwise
  // escalate to producer-required (the DM-resize pattern, rule 2b).
  //
  // Spec 017 lifted the absolute-timing gate: the ADR-0003 3-arm interception-
  // neutrality probe RAN and cleared (fixed, body-size-independent overhead →
  // cancels in the baseline-vs-treatment delta), so a confirmed absolute-timing
  // delta is now publishable (metricGate absolute-timing-cleared), the same
  // autonomous-publish license CLS has — NOT a diagnostic-only signal. The risky
  // UNconfirmed case below still escalates to producer-required (route-enforced).
  if (confirmedReservable) {
    return emit(CLASS2, 'absolute-timing-cleared',
      `absolute-timing (${metric}) delta confirmed by 016-07 as attributed + reservable — Class 2, publishable: the ADR-0003 3-arm interception-neutrality probe cleared in spec 017 (interception overhead is fixed + body-size-independent → cancels in the delta), so this is no longer diagnostic-only (metricGate absolute-timing-cleared, rule 2b as amended by 017)`);
  }
  return emit(CLASS3_ARCH, 'n/a',
    `absolute-timing (${metric}) delta NOT confirmed by source-attribution as a delta-shaped deployable form (${outcome ? `outcome ${outcome}, role ${role}` : 'no attribution'}) — escalated to producer-required per rule 2b (the DM-resize / entangled-architectural pattern)`);
}

// --------------------------------------------------------------------------
// Attribution need (pure) — which fixes REQUIRE resolving 016-07 first.
// --------------------------------------------------------------------------

/**
 * True when classifying this fix needs a resolved attribution. Attribution is
 * only consulted for a Class-2-candidate CSS delta AND only when there is an
 * implicated clientlib URL — that is the only artifact 016-07 can attribute back
 * to a source region.
 *
 * Consequences that fall out of this (both correct per the ACs):
 *   - A CLS delta with no clientlib URL skips attribution → Class 2 cls-ok
 *     (delta-splice licensed without it, rule 2b).
 *   - An absolute-timing delta with no clientlib URL is never attributed →
 *     attribution stays null → classifyFix escalates to producer-required
 *     (rule 2b: no confirmed delta-shaped deployable form — the DM-resize
 *     pattern, where the "fix" is a URL-param rewrite with no attributable
 *     source region).
 *
 * This keeps the attribute() network call off the hot path AND makes the
 * "cannot confirm" absolute-timing case escalate exactly as the spike requires.
 * @param {object} fix
 * @returns {boolean}
 */
function fixNeedsAttribution(fix) {
  const o = normOp(fix && fix.op);
  if (!opIsCssDelta(o, fix && fix.details)) return false;
  return !!(fix && fix.implicatedClientlibUrl);
}

// --------------------------------------------------------------------------
// Default attribution wiring (016-07 readClientlib) — lazily imported so tests
// never pull the network-capable module unless they exercise the default path.
// --------------------------------------------------------------------------

/**
 * Build the default `attribute` fn wired to 016-07's readClientlib. Resolves the
 * served clientlib URL back to a source region for a target selector.
 * @param {object} [opts]
 * @param {string} [opts.sourceRoot]
 * @param {Function} [opts.fetchImpl]
 * @returns {(args:{selector?:string,url?:string,sourceRoot?:string})=>Promise<object|null>}
 */
function defaultAttribute(opts = {}) {
  return async ({ selector, url, sourceRoot } = {}) => {
    if (!url) return null;
    const { readClientlib } = await import('./clientlib-reader.js');
    return readClientlib({
      url,
      target: selector,
      sourceRoot: sourceRoot || opts.sourceRoot || null,
      fetchImpl: opts.fetchImpl || globalThis.fetch,
    });
  };
}

// --------------------------------------------------------------------------
// The orchestrator (AC 1/4)
// --------------------------------------------------------------------------

/**
 * Classify a list of fixes: resolve attribution per fix (only where a rule needs
 * it), call `classifyFix`, and return the full entry list + an operator summary.
 *
 * @param {object} opts
 * @param {Array<object>} opts.fixes   [{ id, metric, op, selector?, implicatedClientlibUrl?, details? }]
 * @param {string} [opts.sourceRoot]   passed to the default attribute() (unused when stubbed).
 * @param {Function} [opts.attribute]  INJECTABLE async ({selector,url,sourceRoot}) => attributionResult.
 *                                     Defaults to the 016-07 wiring; tests stub it.
 * @returns {Promise<{entries:Array<object>, summary:object}>}
 */
async function classifyFixes(opts) {
  const {
    fixes = [],
    sourceRoot = null,
    attribute = defaultAttribute({ sourceRoot }),
  } = opts || {};
  if (!Array.isArray(fixes)) throw new TypeError('fixes must be an array');

  const entries = [];
  for (const fix of fixes) {
    let attribution = null;
    if (fixNeedsAttribution(fix)) {
      try {
        attribution = await attribute({
          selector: fix.selector,
          url: fix.implicatedClientlibUrl,
          sourceRoot,
        });
      } catch (err) {
        // A failed attribution is a failure to confirm → let classifyFix escalate
        // via its "no confirmation" branches. Record why on the entry.
        attribution = { outcome: 'unreadable', structuralRole: 'unknown', reason: `attribute() failed: ${err && err.message ? err.message : err}` };
      }
    }
    entries.push(classifyFix({ ...fix, attribution }));
  }

  return { entries, summary: buildSummary(entries) };
}

// --------------------------------------------------------------------------
// Operator summary (AC 4)
// --------------------------------------------------------------------------

/**
 * "validates now" = Class 1 / Class 2 / Class 3-clientlib (all lab-validatable —
 * mode-a, delta-splice, or a local Mode-B build). "guidance-only" = everything on
 * the `producer-required` route (a literal Class 3-htl restructure, or a 2b/2c/2d
 * architectural escalation the workbench cannot deploy as a delta). The route is
 * the load-bearing split: `producer-required` is exactly the guidance-only set.
 * @param {Array<object>} entries
 * @returns {{total:number, validatesNow:number, guidanceOnly:number, byRoute:object, line:string}}
 */
function buildSummary(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byRoute = {};
  let validatesNow = 0;
  let guidanceOnly = 0;
  for (const e of list) {
    byRoute[e.route] = (byRoute[e.route] || 0) + 1;
    if (e.route === 'producer-required') guidanceOnly += 1;
    else validatesNow += 1;
  }
  const line = `${list.length} fix(es): ${validatesNow} validate now `
    + `(Class 1 mode-a, Class 2 delta-splice, Class 3-clientlib local build), `
    + `${guidanceOnly} guidance-only (Class 3-htl producer-required).`;
  return { total: list.length, validatesNow, guidanceOnly, byRoute, line };
}

// --------------------------------------------------------------------------
// Artifact envelope (AC 5, ADR-0012)
// --------------------------------------------------------------------------

/**
 * Build the `classification.json` phase-interface artifact (ADR-0012 envelope,
 * mirroring remediation-payload.js's shape).
 * @param {object} opts
 * @param {Array<object>} opts.entries
 * @param {string} [opts.stack]
 * @param {string} [opts.sourceArtifact]
 * @returns {object}
 */
function buildClassification(opts) {
  const { entries = [], stack = null, sourceArtifact = 'patches.json' } = opts || {};
  return {
    schemaVersion: '1.0',
    kind: 'fix-classification',
    generatedAt: new Date().toISOString(),
    sourceArtifact,
    stack,
    entries,
    summary: buildSummary(entries),
  };
}

// --------------------------------------------------------------------------
// patches.json → fix list (CLI plumbing, pure)
// --------------------------------------------------------------------------

/**
 * Turn a patches.json object into a flat fix list the classifier consumes.
 * Accepts a Finding with `.patches` or a raw patches object. Op names mirror the
 * patch-type keys source-mapper.js understands (preloads/markup/block/…), plus a
 * `css`/`rewriteBody` bucket for delta-shaped changes.
 *
 * `metricByKey` (from a fix-findings envelope, keyed by generated id) supplies
 * per-fix metric; absent it, metric is 'unknown'.
 *
 * @param {object} patchesObj
 * @param {object} [metaById]  optional { id -> { metric } } overrides.
 * @returns {Array<object>}
 */
function fixesFromPatches(patchesObj, metaById = {}) {
  const p = patchesObj && patchesObj.patches && typeof patchesObj.patches === 'object'
    ? patchesObj.patches
    : (patchesObj || {});
  const baseId = patchesObj && patchesObj.id ? String(patchesObj.id) : 'fix';
  const baseMetric = (metaById[baseId] && metaById[baseId].metric)
    || (Array.isArray(patchesObj && patchesObj.metric) ? patchesObj.metric[0] : patchesObj && patchesObj.metric)
    || 'unknown';

  const fixes = [];
  let n = 0;
  const push = (op, extra) => {
    const id = `${baseId}#${n}`;
    n += 1;
    const meta = metaById[id] || metaById[baseId] || {};
    fixes.push({
      id,
      op,
      metric: meta.metric || baseMetric,
      ...extra,
    });
  };

  for (const preload of arr(p.preloads)) push('preloads', { details: preload });
  for (const m of arr(p.markup)) push('markup', { selector: m.selector, details: m });
  for (const pat of arr(p.block)) push('block', { details: { pattern: pat } });
  for (const r of arr(p.responseHeaders)) push('responseHeaders', { details: r });
  for (const r of arr(p.requestHeaders)) push('requestHeaders', { details: r });
  if (p.rewriteBody) push('rewriteBody', { details: typeof p.rewriteBody === 'object' ? p.rewriteBody : { value: p.rewriteBody } });
  for (const c of arr(p.css)) push('css-override', { selector: c.selector, implicatedClientlibUrl: c.url || c.clientlib, details: c });

  return fixes;
}

function arr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { output: 'classification.json' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--patches') out.patches = argv[++i];
    else if (a === '--findings') out.findings = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--stack') out.stack = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/**
 * Build an { id -> { metric } } map from a fix-findings envelope, so patches can
 * be joined to their finding's target metric.
 * @param {object} envelope
 * @returns {object}
 */
function metaFromFindings(envelope) {
  const findings = envelope && Array.isArray(envelope.findings)
    ? envelope.findings
    : (envelope ? [envelope] : []);
  const map = {};
  for (const f of findings) {
    if (!f || typeof f !== 'object' || !f.id) continue;
    const metric = Array.isArray(f.metric) ? f.metric[0] : f.metric;
    map[String(f.id)] = { metric: metric || 'unknown' };
  }
  return map;
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (args.help || !args.patches || !args.repo) {
    process.stdout.write(
      'Usage: node fix-classifier.js --patches <patches.json> [--findings <fix-findings.json>]\n'
      + '                             --repo <root> [--stack <name>] [--output <classification.json>]\n',
    );
    process.exit(args.help ? 0 : 2);
    return;
  }

  const patchesPath = path.resolve(args.patches);
  const repoRoot = path.resolve(args.repo);
  const patchesObj = JSON.parse(fs.readFileSync(patchesPath, 'utf8'));

  let metaById = {};
  if (args.findings) {
    const fEnv = JSON.parse(fs.readFileSync(path.resolve(args.findings), 'utf8'));
    metaById = metaFromFindings(fEnv);
  }

  const stack = args.stack || detectStack(repoRoot).stack;
  const fixes = fixesFromPatches(patchesObj, metaById);
  const { entries } = await classifyFixes({ fixes, stack, sourceRoot: repoRoot });
  const artifact = buildClassification({
    entries,
    stack,
    sourceArtifact: path.basename(patchesPath),
  });

  fs.writeFileSync(args.output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`${artifact.summary.line}\n`);
  process.stdout.write(`classification → ${args.output}\n`);
}

export {
  classifyFix,
  classifyFixes,
  buildClassification,
  // pure helpers (exported for tests + reuse)
  metricClass,
  fixNeedsAttribution,
  fixesFromPatches,
  buildSummary,
  defaultAttribute,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain().catch((err) => { process.stderr.write(String((err && err.stack) || err) + '\n'); process.exit(1); });
}
