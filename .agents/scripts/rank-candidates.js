#!/usr/bin/env node

/**
 * rank-candidates.js — transform a cwv-diagnose findings envelope into the
 * ranked_patches.json format consumed by cwv-orchestrate.
 *
 * Deterministic (no LLM): reads diagnose-findings.json, filters to findings
 * that are actionable (status=proposed AND non-empty patches), computes a
 * rank score (expectedImpact × confidence), sorts, and emits
 * ranked_patches.json.
 *
 * Usage:
 *   node .agents/scripts/rank-candidates.js \
 *     --findings progress/<slug>/diagnose-findings.json \
 *     --url      https://example.com/ \
 *     --output   progress/<slug>/ranked_patches.json
 *
 * Exit codes:
 *   0 = success (ranked_patches written, candidates possibly empty)
 *   1 = input error (unreadable / invalid JSON / not a findings envelope)
 *   2 = no candidates after filtering (informational; caller decides)
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalUrl, extractUrlsFromSelector } from './url-canonical.js';
import { SOURCE_TIERS } from './finding-schema.js';

// Unknown / missing source sorts below every known tier (1=field … 4=speculative)
// but ties with other unknowns, so it never silently wins a keeper slot.
const UNKNOWN_TIER = 99;

/**
 * Best (numerically lowest = most authoritative) source tier for a candidate,
 * considering its primary `source` and any `mergedSources`. Field (crux/rum)=1,
 * lab (psi/har/perf_observer/coverage)=2, static (html/rules)=3, speculative
 * (code)=4. Encodes the source-tier precedence the dedup keeper must honour
 * (cwv-analyze Rule 5a; chain-rum-correlation "field takes precedence").
 * @param {{source?:string, mergedSources?:string[]}} c
 * @returns {number}
 */
function sourceTierOf(c) {
  const srcs = [];
  if (c && c.source) srcs.push(c.source);
  if (c && Array.isArray(c.mergedSources)) srcs.push(...c.mergedSources);
  let best = UNKNOWN_TIER;
  for (const s of srcs) {
    const t = SOURCE_TIERS[s] && SOURCE_TIERS[s].tier;
    if (typeof t === 'number' && t < best) best = t;
  }
  return best;
}

const HELP = `
rank-candidates.js — diagnose-findings.json → ranked_patches.json

Usage:
  node .agents/scripts/rank-candidates.js [flags]

Flags:
  --findings <path>    Input: diagnose findings envelope (required)
  --url <url>          Override url in output (default: envelope.url)
  --output <path>      Where to write ranked_patches.json (default: stdout)
  --min-confidence <n> Drop candidates below this confidence (default: 0.5)
  --help               Print this help and exit 0

Exit codes:
  0 = success, 1 = input error, 2 = zero candidates after filtering
`;

function parseArgs(argv) {
  const args = {
    findings: null,
    url: null,
    output: null,
    minConfidence: 0.5,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--help': case '-h': args.help = true; break;
      case '--findings': args.findings = next(); break;
      case '--url': args.url = next(); break;
      case '--output': args.output = next(); break;
      case '--min-confidence': args.minConfidence = parseFloat(next()); break;
      default:
        if (a && a.startsWith('--')) {
          process.stderr.write(`Unknown flag: ${a}\n`);
          process.exit(1);
        }
    }
  }
  return args;
}

/**
 * Flatten a findings envelope or a bare findings array or a single finding
 * into an array of findings. Matches how finding-schema.js:validateEnvelope
 * accepts either an envelope or a single finding.
 */
function extractFindings(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.findings)) return obj.findings;
  // Bare finding (has id + cause).
  if (obj.id && obj.cause) return [obj];
  return [];
}

/**
 * "Impact" in milliseconds-equivalent for ranking. CLS uses score (0..1);
 * multiplying by 1000 puts it on a comparable magnitude scale to ms metrics
 * so a 0.05 CLS improvement (50 "units") ranks roughly with a 50ms metric
 * improvement. This is a ranking heuristic, not a claim about equivalence.
 */
function impactMsEquivalent(ir) {
  if (!ir || typeof ir !== 'object') return 0;
  if (typeof ir.valueMs === 'number') return Math.abs(ir.valueMs);
  if (typeof ir.score === 'number') return Math.abs(ir.score) * 1000;
  return 0;
}

function hasNonEmptyPatches(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  for (const key of Object.keys(p)) {
    const v = p[key];
    if (Array.isArray(v) && v.length > 0) return true;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) return true;
  }
  return false;
}

/**
 * Turn a finding into an orchestrate candidate. Returns null if the finding
 * is not a viable candidate (wrong status, no patches, below min confidence).
 */
function findingToCandidate(f, minConfidence) {
  if (!f || typeof f !== 'object') return null;
  if (f.status !== 'proposed') return null;
  if (!hasNonEmptyPatches(f.patches)) return null;
  if (typeof f.confidence !== 'number' || f.confidence < minConfidence) return null;

  const impact = impactMsEquivalent(f.impactReduction);
  const metric = Array.isArray(f.metric) && f.metric.length ? f.metric[0] : null;
  if (!metric) return null;

  const rankScore = impact * f.confidence;
  return {
    id: f.id,
    findingId: f.id,
    metric,
    expectedImpactMs: f.impactReduction && typeof f.impactReduction.valueMs === 'number'
      ? f.impactReduction.valueMs
      : null,
    expectedImpactScore: f.impactReduction && typeof f.impactReduction.score === 'number'
      ? f.impactReduction.score
      : null,
    confidence: f.confidence,
    rankScore,
    patch: f.patches,
    recommendation: typeof f.recommendation === 'string' ? f.recommendation : '',
    severity: f.severity || null,
    source: f.source || null,
    // Preserved when the finding arrives already cross-source-merged (e.g. the
    // correlator's source:"rum" + mergedSources:["rum","har"]) so source-tier
    // precedence sees the field corroboration. Omitted when absent.
    mergedSources: Array.isArray(f.mergedSources) ? f.mergedSources.slice() : undefined,
    rootCause: f.rootCause === true,
  };
}

function normalizeStructuralGate(gate, source = {}) {
  if (!gate || typeof gate !== 'object') return null;
  if (gate.name && gate.name !== 'structural-contract') return null;
  if (!gate.result && gate.name !== 'structural-contract') return null;
  const out = {
    name: gate.name || 'structural-contract',
    result: gate.result || 'warn',
    reasons: Array.isArray(gate.reasons) ? gate.reasons : [],
  };
  if (source.findingId) out.sourceFindingId = source.findingId;
  if (source.file) out.sourceFile = source.file;
  return out;
}

function structuralGateFromFinding(f) {
  if (!f || typeof f !== 'object') return null;
  const direct = normalizeStructuralGate(f.structuralGate, { findingId: f.id });
  if (direct) return direct;
  for (const ev of f.evidence || []) {
    const data = ev && ev.data;
    if (!data || data.ruleId !== 'html/structural-contract') continue;
    const context = data.context || {};
    return {
      name: 'structural-contract',
      result: context.gateResult || context.result || 'warn',
      reasons: Array.isArray(context.reasons) ? context.reasons : [],
      sourceFindingId: f.id,
    };
  }
  return null;
}

function structuralGateFromEnvelope(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const gate = obj.structuralGate
    || (obj.meta && obj.meta.structuralGate)
    || (obj.summary && obj.summary.structuralGate);
  return normalizeStructuralGate(gate, { file: obj.file || null });
}

function deriveStructuralGate(input) {
  const gates = [];
  const envelopeGate = structuralGateFromEnvelope(input);
  if (envelopeGate) gates.push(envelopeGate);
  gates.push(...extractFindings(input).map(structuralGateFromFinding).filter(Boolean));
  if (gates.length === 0) {
    return {
      name: 'structural-contract',
      result: 'not-run',
      sourceFindingIds: [],
      sourceFiles: [],
      reasons: [],
    };
  }

  const severity = { fail: 3, warn: 2, pass: 1, 'not-run': 0 };
  const result = gates.reduce((worst, gate) => (
    (severity[gate.result] || 0) > (severity[worst] || 0) ? gate.result : worst
  ), 'not-run');
  const reasons = [];
  const sourceFindingIds = [];
  const sourceFiles = [];
  for (const gate of gates) {
    if (gate.sourceFindingId && !sourceFindingIds.includes(gate.sourceFindingId)) {
      sourceFindingIds.push(gate.sourceFindingId);
    }
    if (gate.sourceFile && !sourceFiles.includes(gate.sourceFile)) {
      sourceFiles.push(gate.sourceFile);
    }
    for (const reason of gate.reasons || []) {
      if (typeof reason === 'string' && reason.trim() && !reasons.includes(reason.trim())) {
        reasons.push(reason.trim());
      }
    }
  }
  return {
    name: 'structural-contract',
    result,
    sourceFindingIds,
    sourceFiles,
    reasons,
  };
}

function patchLooksLikeSelectorLayoutShim(patch) {
  if (!patch || typeof patch !== 'object') return false;
  if (Array.isArray(patch.markup)) {
    for (const item of patch.markup) {
      if (!item || typeof item !== 'object') continue;
      const attrs = item.attrs && typeof item.attrs === 'object' ? item.attrs : {};
      const keys = Object.keys(attrs).map((key) => key.toLowerCase());
      if (keys.some((key) => ['style', 'class', 'hidden'].includes(key))) return true;
      const values = Object.values(attrs).map((value) => String(value || '').toLowerCase()).join(' ');
      if (/\b(min-height|height|display|visibility|opacity|position|padding|margin)\b/.test(values)) return true;
    }
  }
  if (Array.isArray(patch.rewriteBody)) {
    const text = JSON.stringify(patch.rewriteBody).toLowerCase();
    if (/\b(min-height|height|display|visibility|opacity|position|padding|margin)\b/.test(text)) return true;
  }
  return false;
}

function structuralGateBlocksCandidate(candidate, gate) {
  if (!candidate || !gate || gate.result !== 'fail') return false;
  if (candidate.metric !== 'CLS') return false;
  return patchLooksLikeSelectorLayoutShim(candidate.patch);
}

function applyStructuralGateToCandidates(candidates, gate) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map((candidate) => {
    const next = { ...candidate };
    if (!structuralGateBlocksCandidate(candidate, gate)) return next;
    const originalConfidence = typeof next.confidence === 'number' ? next.confidence : 0;
    const cappedConfidence = Math.min(originalConfidence, 0.49);
    const impact = impactMsEquivalent({
      metric: next.metric,
      valueMs: next.expectedImpactMs,
      score: next.expectedImpactScore,
    });
    next.originalConfidence = originalConfidence;
    next.confidence = cappedConfidence;
    next.rankScore = impact * cappedConfidence;
    next.probeOnly = true;
    next.promotionBlocked = true;
    next.promotionBlockReason = 'Structural gate failed; selector-level CLS layout shim is a probe until the reveal/page-shape contract is restored and cross-metric guards pass.';
    next.structuralGate = {
      name: gate.name,
      result: gate.result,
      sourceFindingIds: gate.sourceFindingIds,
      reasons: gate.reasons,
    };
    return next;
  });
}

/**
 * Infer a coarse "intervention type" from a patch bundle. Used as part of
 * the dedup group key so two candidates that touch the same resource via
 * DIFFERENT interventions (e.g. fetchpriority vs preload) stay separate.
 *
 * Resilient to the #13 emitter churn where `name` may be `attr` (or vice
 * versa) — we look at both fields and take whichever is defined.
 *
 * Returns null when no classifiable patch is present.
 *
 * @param {object} patches
 * @param {object} patches.markup
 * @returns {string|null}
 */
function inferInterventionType(patches) {
  if (!patches || typeof patches !== 'object') return null;

  if (Array.isArray(patches.preloads) && patches.preloads.length > 0) return 'preload';

  if (Array.isArray(patches.markup) && patches.markup.length > 0) {
    for (const p of patches.markup) {
      // Resilient to #13 attr/name churn: check both, plus attrs object form.
      const attrName = (p && (p.name || p.attr)) || null;
      if (attrName === 'fetchpriority') return 'fetchpriority';
      if (attrName === 'defer') return 'defer';
      if (attrName === 'async') return 'async';
      if (attrName === 'loading') return 'loading';
      if (attrName === 'style') return 'style-inline';
      // Newer emitters use `attrs: { fetchpriority: 'high' }` in lieu of name/value.
      if (p && p.attrs && typeof p.attrs === 'object') {
        const keys = Object.keys(p.attrs);
        if (keys.includes('fetchpriority')) return 'fetchpriority';
        if (keys.includes('defer')) return 'defer';
        if (keys.includes('async')) return 'async';
        if (keys.includes('loading')) return 'loading';
        if (keys.includes('style')) return 'style-inline';
      }
      const action = p && p.action ? p.action : '?';
      const tag = attrName || (p && p.attrs ? Object.keys(p.attrs)[0] : null) || '?';
      return `other:${action}:${tag}`;
    }
  }

  if (Array.isArray(patches.headers) && patches.headers.length > 0) return 'header';
  if (Array.isArray(patches.blocks) && patches.blocks.length > 0) return 'block';

  return null;
}

/**
 * Pull every URL reference we can find in a finding's evidence or patches,
 * canonicalized. Duplicates removed, stable order.
 *
 * Sources scanned:
 *   - evidence[].data.url                    (resource-timing, har-entry, coverage-row…)
 *   - evidence[].data.match                  (rule-violation — often a URL literal)
 *   - evidence[].data.context.attrs.src/href (rule-violation img/script/link attrs)
 *   - patches.preloads[].href
 *   - patches.markup[].selector              via extractUrlsFromSelector()
 *
 * @param {object} f  Finding object.
 * @returns {string[]} canonical URLs (no duplicates).
 */
function extractCanonicalUrls(f) {
  if (!f || typeof f !== 'object') return [];
  const base = typeof f.url === 'string' ? f.url : undefined;
  const seen = new Set();
  const add = (raw) => {
    if (typeof raw !== 'string' || !raw) return;
    const c = canonicalUrl(raw, base);
    if (c && !seen.has(c)) seen.add(c);
  };

  // Prefer the URLs the patch actually touches. Evidence often includes
  // contextual URLs, such as the LCP image on a font-preload finding; using
  // those as dedupe keys merges unrelated candidates.
  if (f.patches && typeof f.patches === 'object') {
    if (Array.isArray(f.patches.preloads)) {
      for (const p of f.patches.preloads) if (p && typeof p.href === 'string') add(p.href);
    }
    if (Array.isArray(f.patches.markup)) {
      for (const p of f.patches.markup) {
        if (!p || typeof p.selector !== 'string') continue;
        for (const ref of extractUrlsFromSelector(p.selector)) {
          if (ref.mode === 'exact') add(ref.url);
        }
      }
    }
  }
  if (seen.size > 0) return Array.from(seen);

  if (Array.isArray(f.evidence)) {
    for (const ev of f.evidence) {
      const d = ev && ev.data;
      if (!d) continue;
      if (typeof d.url === 'string') add(d.url);
      // `match` often carries a URL literal in rule-violation evidence.
      if (typeof d.match === 'string' && /https?:\/\/|^\//.test(d.match)) add(d.match);
      const attrs = d.context && d.context.attrs;
      if (attrs && typeof attrs === 'object') {
        if (typeof attrs.src === 'string') add(attrs.src);
        if (typeof attrs.href === 'string') add(attrs.href);
      }
    }
  }

  return Array.from(seen);
}

/**
 * Extract attribution.target values from a finding's evidence. Used as an
 * alternate match key: two findings hitting the same DOM element are
 * duplicates even when they cite the resource URL differently (e.g. a
 * <picture><source> sibling points at a .webp but the <img> fallback
 * selector points at a .jpg).
 *
 * Ignores null / empty targets.
 *
 * @param {object} f
 * @returns {string[]}
 */
function extractAttributionTargets(f) {
  if (!f || !Array.isArray(f.evidence)) return [];
  const out = [];
  for (const ev of f.evidence) {
    if (!ev || ev.kind !== 'cwv-attribution') continue;
    const t = ev.data && ev.data.target;
    if (typeof t === 'string' && t.trim()) out.push(t.trim());
  }
  return out;
}

/**
 * Deduplicate candidates whose findings target the same (metric,
 * canonical-resource-url, intervention-type) OR (metric,
 * attribution.target, intervention-type). Within a group, keep the
 * highest-rankScore candidate; fold the others into its
 * `relatedFindingIds` and union their source(s) into `mergedSources`.
 *
 * Candidates with no extractable URL AND no attribution.target pass
 * through unchanged (no safe match key).
 *
 * Logs each merge to stderr so operators see which findings collapsed.
 *
 * @param {object[]} candidates  Pre-ranked candidates from findingToCandidate.
 * @param {object[]} findings    The full finding objects, same order index as candidates.
 * @returns {object[]}           Deduped candidate array.
 */
function dedupeCandidates(candidates, findings) {
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;

  // Build union-find over candidates by shared match keys.
  const n = candidates.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };

  // Key → first candidate index.
  const urlKeyIndex = new Map();
  const targetKeyIndex = new Map();

  const findingById = new Map();
  for (const f of findings) if (f && f.id) findingById.set(f.id, f);

  const meta = candidates.map((c) => {
    const f = findingById.get(c.findingId) || {};
    const intervention = inferInterventionType(f.patches || c.patch);
    return {
      metric: c.metric,
      intervention,
      urls: extractCanonicalUrls(f),
      targets: extractAttributionTargets(f),
    };
  });

  for (let i = 0; i < n; i++) {
    const { metric, intervention, urls, targets } = meta[i];
    if (!intervention) continue;
    for (const u of urls) {
      const k = `${metric}||${intervention}||url=${u}`;
      if (urlKeyIndex.has(k)) union(i, urlKeyIndex.get(k));
      else urlKeyIndex.set(k, i);
    }
    for (const t of targets) {
      const k = `${metric}||${intervention}||target=${t}`;
      if (targetKeyIndex.has(k)) union(i, targetKeyIndex.get(k));
      else targetKeyIndex.set(k, i);
    }
  }

  // Group by root. Within each group keep highest rankScore (then confidence,
  // then lexical id — mirrors rankCandidates tie-break), fold others in.
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const dropped = new Set();
  for (const [, idxs] of groups) {
    if (idxs.length < 2) continue;
    idxs.sort((x, y) => {
      const cx = candidates[x], cy = candidates[y];
      // Source-tier precedence FIRST (cwv-analyze Rule 5a): a field finding
      // (rum/crux) keeps the slot over a higher-rankScore lab finding on the
      // same resource — field evidence is ground truth for "users feel this."
      const tx = sourceTierOf(cx), ty = sourceTierOf(cy);
      if (tx !== ty) return tx - ty;
      if (cy.rankScore !== cx.rankScore) return cy.rankScore - cx.rankScore;
      if (cy.confidence !== cx.confidence) return cy.confidence - cx.confidence;
      return cx.id < cy.id ? -1 : cx.id > cy.id ? 1 : 0;
    });
    const keepIdx = idxs[0];
    const keeper = candidates[keepIdx];
    const keeperTier = sourceTierOf(keeper);
    const related = new Set(Array.isArray(keeper.relatedFindingIds) ? keeper.relatedFindingIds : []);
    const mergedSources = new Set(Array.isArray(keeper.mergedSources) ? keeper.mergedSources : []);
    if (keeper.source) mergedSources.add(keeper.source);

    for (let j = 1; j < idxs.length; j++) {
      const loserIdx = idxs[j];
      const loser = candidates[loserIdx];
      related.add(loser.findingId);
      if (Array.isArray(loser.relatedFindingIds)) for (const rid of loser.relatedFindingIds) related.add(rid);
      if (loser.source) mergedSources.add(loser.source);
      dropped.add(loserIdx);
      process.stderr.write(JSON.stringify({
        event: 'rank-candidates.dedupe',
        kept: keeper.id,
        dropped: loser.id,
        metric: keeper.metric,
        intervention: meta[keepIdx].intervention,
        // Distinguish a tier-driven win (Rule 5a — field kept over a higher-rank
        // lab finding) from a plain same-resource rankScore merge, for audit.
        reason: sourceTierOf(loser) > keeperTier ? 'source-tier-precedence' : 'same-resource-or-target',
      }) + '\n');
    }
    keeper.relatedFindingIds = Array.from(related);
    keeper.mergedSources = Array.from(mergedSources);
  }

  return candidates.filter((_, i) => !dropped.has(i));
}

/**
 * Stable sort: primary by rankScore desc, tie-break by confidence desc,
 * then by id ascending (alphabetic) so identical scores produce identical
 * ordering across runs.
 */
function rankCandidates(candidates) {
  return candidates.slice().sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function rank(envelope, { url, minConfidence } = {}) {
  const findings = extractFindings(envelope);
  const structuralGate = deriveStructuralGate(envelope);
  const all = findings
    .map((f) => findingToCandidate(f, minConfidence != null ? minConfidence : 0.5))
    .filter(Boolean);
  // Dedup pass — collapse candidates that target the same canonical resource
  // URL + intervention, OR the same attribution.target + intervention.
  // See .agents/skills/cwv-analyze.md Rule 5e.
  const deduped = dedupeCandidates(all, findings);
  const mergedAway = all.length - deduped.length;
  const gated = applyStructuralGateToCandidates(deduped, structuralGate);
  const sorted = rankCandidates(gated);
  const outUrl = url || (envelope && envelope.url) || (findings[0] && findings[0].url) || null;
  return {
    schemaVersion: '1.0',
    url: outUrl,
    generatedAt: new Date().toISOString(),
    structuralGate,
    sourceFindings: findings.length,
    dropped: findings.length - all.length,
    mergedDuplicates: mergedAway,
    candidates: sorted,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); process.exit(0); }

  if (!args.findings) {
    process.stderr.write('Error: --findings is required.\n' + HELP);
    process.exit(1);
  }

  let envelope;
  try {
    const raw = fs.readFileSync(path.resolve(args.findings), 'utf8');
    envelope = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message, phase: 'read' }) + '\n');
    process.exit(1);
  }

  const out = rank(envelope, { url: args.url, minConfidence: args.minConfidence });
  const json = JSON.stringify(out, null, 2);
  if (args.output) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
      fs.writeFileSync(args.output, json);
    } catch (err) {
      process.stderr.write(JSON.stringify({ error: err.message, phase: 'write-output' }) + '\n');
      process.exit(1);
    }
  } else {
    process.stdout.write(json + '\n');
  }

  process.exit(out.candidates.length === 0 ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err && err.message || String(err), phase: 'main' }) + '\n');
    process.exit(1);
  }
}

export {
  parseArgs,
  extractFindings,
  impactMsEquivalent,
  hasNonEmptyPatches,
  findingToCandidate,
  rankCandidates,
  inferInterventionType,
  extractCanonicalUrls,
  extractAttributionTargets,
  dedupeCandidates,
  sourceTierOf,
  deriveStructuralGate,
  applyStructuralGateToCandidates,
  structuralGateBlocksCandidate,
  patchLooksLikeSelectorLayoutShim,
  rank,
};
