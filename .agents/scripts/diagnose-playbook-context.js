#!/usr/bin/env node

/**
 * diagnose-playbook-context.js — the 015-03 diagnose consumer of the playbook
 * chain resolver (ADR-0015 §3).
 *
 * `buildDiagnosisPlaybookContext(issueType, flavor, opts)` assembles the
 * `resolveChain` closure's playbook BODIES into ONE ordered context string so
 * the `cwv-diagnose` agent reads the expert decision tree (root playbook first,
 * then its typed `see_also` closure in resolver order) BEFORE finalizing a root
 * cause — instead of rediscovering the routing tree from scratch.
 *
 * Edge policy (ADR-0015 §3): diagnose is NOISE-TOLERANT — it follows ALL edge
 * types (routes_to, prefer_instead, complements, orthogonal). The resolver
 * already tags each entry with the edge set that reached it; this consumer does
 * not filter on edge type, it just surfaces them in each section header so the
 * agent sees HOW a playbook was reached. Depth is capped via `opts.depth`
 * (passed straight through to the resolver).
 *
 * Budget: the concatenation is bounded by `opts.maxChars` (default
 * DEFAULT_MAX_CHARS). Appending the next body is skipped once it would exceed
 * the bound — the remaining closure is OMITTED, never an error. This keeps the
 * injected context inside a sane budget on the widest-fan-out metrics.
 *
 * Pure + deterministic: for a given (issueType, flavor, opts, playbook dir) the
 * output is byte-identical across runs (resolveChain is deterministic and this
 * layer only concatenates in that fixed order). Graceful: an unknown/absent
 * root (resolveChain -> []) returns '' and never throws; a closure entry whose
 * body cannot be loaded is skipped.
 *
 * Reuse, not duplication:
 *   - closure ordering + edge tags + flavor filter + depth cap come from
 *     playbook-chain.js (`resolveChain`);
 *   - each entry's body text comes from attribution.js (`loadPlaybook`).
 */

import { resolveChain } from './playbook-chain.js';
import { loadPlaybook } from './attribution.js';

/**
 * Default character budget for the assembled context string. Sized so the
 * widest real router (layout-shift, whose body alone is ~19k chars) plus its
 * direct routes_to children (image-sizing + font-fallback) fit — that is the
 * decision tree the diagnose agent must actually see — while still bounding the
 * long tail of orthogonal/complements playbooks reached at deeper hops. A
 * diagnose agent reads this inline, so ~40k chars (roughly 10k tokens) is a sane
 * ceiling that leaves room for the run evidence around it. Consumers may
 * override via `opts.maxChars`.
 */
export const DEFAULT_MAX_CHARS = 40000;

/**
 * Render one playbook section: a small header naming the playbook + how it was
 * reached (edge types), then its body. Deterministic given the entry + body.
 * @param {{issueType: string, edges: string[], depth: number}} entry
 * @param {string} body
 * @returns {string}
 */
function renderSection(entry, body) {
  const via = entry.edges.join(', ');
  const header = `===== playbook: ${entry.issueType} (reached via: ${via}; depth ${entry.depth}) =====`;
  return `${header}\n${body.trim()}\n`;
}

/**
 * Build the ordered playbook-body context for a diagnosis.
 *
 * @param {string} issueType - the resolved root issue_type (e.g. 'layout-shift').
 * @param {string|null} flavor - eds|cs|ams|headless, or any label resolveFlavor accepts.
 * @param {object} [opts]
 * @param {number} [opts.depth] - max hops from the root (passed to resolveChain).
 * @param {number} [opts.maxChars=DEFAULT_MAX_CHARS] - hard character bound; the
 *   next body is omitted once appending it would exceed this.
 * @param {string} [opts.dir] - override the playbooks directory (test fixtures).
 * @param {string} [opts.source] - a pulled source tree, for flavor resolution.
 * @returns {string} the concatenated, ordered context ('' if the root is unknown).
 */
export function buildDiagnosisPlaybookContext(issueType, flavor, opts = {}) {
  const maxChars = Number.isInteger(opts.maxChars) ? opts.maxChars : DEFAULT_MAX_CHARS;
  const loadOpts = opts.dir ? { dir: opts.dir } : undefined;

  // resolveChain applies the ADR-0015 traversal (all edge types, depth cap via
  // opts.depth, flavor filter, de-dup, cycle-safe) and returns root-first order.
  const chain = resolveChain(issueType, flavor, {
    depth: opts.depth,
    dir: opts.dir,
    source: opts.source,
  });
  if (!Array.isArray(chain) || chain.length === 0) return '';

  const sections = [];
  let total = 0;
  for (const entry of chain) {
    const pb = loadPlaybook(entry.issueType, loadOpts);
    if (!pb || typeof pb.body !== 'string' || !pb.body.trim()) continue; // dangling/empty — skip.
    const section = renderSection(entry, pb.body);
    const addition = sections.length === 0 ? section.length : section.length + 1; // +1 for the joining '\n'.
    if (total + addition > maxChars) break; // budget reached — omit the rest.
    sections.push(section);
    total += addition;
  }

  return sections.join('\n');
}

export default buildDiagnosisPlaybookContext;
