#!/usr/bin/env node

/**
 * fix-classifier.js — the fix-classification gate.
 *
 * Given a `patches.json` (or a fix list) + the detected stack, assign every
 * proposed fix a Class and a recommended validate route, emitted as a
 * phase-interface artifact (`classification.json`) the operator and the
 * validate step consume BEFORE spending any validation runs.
 *
 *   - Class 1 (generic-mutation) → route `patch`         (served-byte patch, lab-validated)
 *   - Class 2 (source-edit)      → route `source-edit`   (source diff, lab-validated via mapped patches)
 *   - Class 3 (structural)       → route `manual-review` (no faithful byte-delta — land in source, re-measure)
 *
 * The classification LOGIC is a PURE function (`classifyFix`) that performs no
 * I/O. The orchestrator (`classifyFixes`) maps the fix list through it and
 * returns the entry list + an operator summary.
 *
 * ---------------------------------------------------------------------------
 * RULES
 * ---------------------------------------------------------------------------
 *
 *   Class 1: op ∈ {attribute, resource-hint (preload/fetchpriority), meta,
 *     defer/async, alt, request/response headers, block, rewriteBody, markup
 *     mutation, CSS add/override} → directly expressible as a served-byte patch
 *     the launcher applies at the CDP Fetch layer; the oracle validates it now.
 *
 *   Class 2: an explicit source edit (op `source-edit`, or a fix carrying
 *     `sourceEdits`) → the deliverable is a source-repo diff; source-mapper
 *     maps it to equivalent served-byte patches so the oracle can validate the
 *     effect BEFORE the user lands the change.
 *
 *   Class 3: a structural DOM-shape / execution-order change (op `reorder`,
 *     `dom-structural`, `template-structural`) → a served-byte patch cannot
 *     faithfully emulate it (interception preserves fetch order, not the
 *     renderer's structural output), so the oracle refuses with a typed
 *     `manual-review` verdict instead of faking a low-fidelity pass. The fix
 *     ships as guidance: land it in source, then re-measure baseline-vs-live.
 *
 *   Ambiguous/unknown op: classify to the HIGHEST applicable class with a
 *     typed reason — never silently Class 1.
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
// Op taxonomy (pure)
// --------------------------------------------------------------------------

// Class-1 ops: generic mutations the CDP patch engine applies directly —
// attribute edits, resource hints, meta, defer, alt, headers, blocking,
// body rewrites, markup mutations, and CSS add/override (injected as a
// <style> rule or a rewritten stylesheet body).
const CLASS1_OPS = new Set([
  'attribute', 'attr', 'markup',
  'preload', 'preloads', 'fetchpriority', 'resource-hint', 'resourcehint',
  'meta',
  'defer', 'async',
  'alt',
  'requestheaders', 'responseheaders',
  'block',
  'rewritebody', 'rewrite-body',
  'css-override', 'cssoverride', 'css-add', 'cssadd', 'css',
]);

// Class-2 ops: an explicit source-repo edit. Also granted when the fix carries
// structured `sourceEdits` records (see classifyFix).
const CLASS2_OPS = new Set([
  'source-edit', 'sourceedit', 'source',
]);

// Class-3 ops: a structural DOM-shape or execution-order change that a
// served-byte patch cannot faithfully emulate.
const CLASS3_OPS = new Set([
  'reorder',
  'dom-structural', 'domstructural',
  'template-structural', 'templatestructural',
]);

function normOp(op) {
  return String(op || '').trim().toLowerCase();
}

// --------------------------------------------------------------------------
// The pure classifier
// --------------------------------------------------------------------------

// Route + subclass presets per class, so the mapping stays single-sourced.
const CLASS1 = { class: 1, subclass: 'generic', route: 'patch' };
const CLASS2 = { class: 2, subclass: 'source', route: 'source-edit' };
const CLASS3 = { class: 3, subclass: 'structural', route: 'manual-review' };

/**
 * Classify a single fix. PURE — performs no I/O.
 *
 * @param {object} fix
 * @param {string}   [fix.id]
 * @param {string}   fix.op            the proposed op / patch type.
 * @param {string}   [fix.metric]      the target metric (CLS/LCP/…; recorded, not load-bearing).
 * @param {string}   [fix.selector]    selector / target.
 * @param {Array}    [fix.sourceEdits] structured source-edit records; presence ⇒ Class 2.
 * @param {object}   [fix.details]     op-specific detail.
 * @returns {{id?:string, class:1|2|3, subclass:string, route:string, rationale:string}}
 */
function classifyFix(fix) {
  const { id, op, sourceEdits } = fix || {};

  const o = normOp(op);
  const emit = (preset, rationale) => ({
    ...(id !== undefined ? { id } : {}),
    class: preset.class,
    subclass: preset.subclass,
    route: preset.route,
    rationale,
  });

  // ---- Class 3: structural / order-dependent change -------------------------
  // Checked first: a structural op is manual-review regardless of anything else.
  if (CLASS3_OPS.has(o)) {
    return emit(CLASS3,
      `structural DOM-shape / execution-order change (op "${op}") — a served-byte patch cannot faithfully emulate it; land it in source and re-measure (manual-review)`);
  }

  // ---- Class 2: explicit source edit ---------------------------------------
  if (CLASS2_OPS.has(o) || (Array.isArray(sourceEdits) && sourceEdits.length > 0)) {
    return emit(CLASS2,
      'source-repo edit — deliverable is a diff; source-mapper maps it to equivalent served-byte patches for lab validation before landing');
  }

  // ---- Class 1: generic mutation (served-byte patch) ------------------------
  if (CLASS1_OPS.has(o)) {
    return emit(CLASS1, `generic mutation (op "${op}") — the CDP patch engine applies it directly; validate now`);
  }

  // ---- Ambiguous / unknown op → HIGHEST applicable class --------------------
  // Never silently Class 1. Default to manual-review with a typed reason.
  return emit(CLASS3,
    `ambiguous/unknown op "${op}" — classified to the highest applicable class (manual-review), never silently Class 1`);
}

// --------------------------------------------------------------------------
// The orchestrator
// --------------------------------------------------------------------------

/**
 * Classify a list of fixes and return the full entry list + an operator summary.
 * Kept async for CLI/API symmetry even though classification is pure.
 *
 * @param {object} opts
 * @param {Array<object>} opts.fixes  [{ id, metric, op, selector?, sourceEdits?, details? }]
 * @returns {Promise<{entries:Array<object>, summary:object}>}
 */
async function classifyFixes(opts) {
  const { fixes = [] } = opts || {};
  if (!Array.isArray(fixes)) throw new TypeError('fixes must be an array');

  const entries = fixes.map((fix) => classifyFix(fix));
  return { entries, summary: buildSummary(entries) };
}

// --------------------------------------------------------------------------
// Operator summary
// --------------------------------------------------------------------------

/**
 * "validates now" = Class 1 / Class 2 (both lab-validatable — a direct patch or
 * a source edit mapped to patches). "manual review" = everything on the
 * `manual-review` route: a structural change the lab cannot faithfully prove as
 * a byte delta. The route is the load-bearing split.
 * @param {Array<object>} entries
 * @returns {{total:number, validatesNow:number, manualReview:number, byRoute:object, line:string}}
 */
function buildSummary(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byRoute = {};
  let validatesNow = 0;
  let manualReview = 0;
  for (const e of list) {
    byRoute[e.route] = (byRoute[e.route] || 0) + 1;
    if (e.route === 'manual-review') manualReview += 1;
    else validatesNow += 1;
  }
  const line = `${list.length} fix(es): ${validatesNow} validate now `
    + `(Class 1 patch, Class 2 source-edit), `
    + `${manualReview} manual-review (structural — land in source, re-measure).`;
  return { total: list.length, validatesNow, manualReview, byRoute, line };
}

// --------------------------------------------------------------------------
// Artifact envelope
// --------------------------------------------------------------------------

/**
 * Build the `classification.json` phase-interface artifact.
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
 * `css`/`rewriteBody` bucket.
 *
 * `metaById` (from a fix-findings envelope, keyed by generated id) supplies
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
  for (const c of arr(p.css)) push('css-override', { selector: c.selector, details: c });

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
  const { entries } = await classifyFixes({ fixes });
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
  fixesFromPatches,
  buildSummary,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain().catch((err) => { process.stderr.write(String((err && err.stack) || err) + '\n'); process.exit(1); });
}
