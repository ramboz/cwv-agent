#!/usr/bin/env node

/**
 * playbook-chain.js — the single, reusable playbook chain resolver
 * (spec 015-02, ADR-0015 §3).
 *
 * `resolveChain(rootIssueType, flavor, opts)` turns a root playbook + a
 * resolved flavor into ONE ordered, de-duped, cycle-safe, depth-capped closure
 * of playbooks over the typed `see_also` graph. Each entry is tagged with the
 * set of edge types by which the node was reached, so the three ADR-0015
 * consumers (015-03 body injection, 015-04 mechanism gate, 015-05 forbidden-
 * technique validator) can each apply their OWN edge policy on top of the same
 * traversal — instead of re-implementing three divergent walks.
 *
 * Reuse, not duplication:
 *   - single-playbook loading + flavor resolution come from attribution.js
 *     (`loadPlaybook`, `resolveFlavor`);
 *   - `see_also` front-matter parsing comes from playbook-see-also-lint.js
 *     (`extractFrontMatter`, `parseSeeAlso`).
 *
 * Traversal contract:
 *   - Ordering (AC-2): breadth-first from the root. At each node the outgoing
 *     see_also edges are visited in a fixed, deterministic order — first by the
 *     edge-type rank below (routes_to, prefer_instead, complements, orthogonal),
 *     then alphabetically by target playbook. This makes the output stable
 *     across runs regardless of authoring order in the front-matter.
 *   - De-dup (AC-3): a node reached by several paths appears ONCE, retaining
 *     the UNION of the edge types by which it was reached.
 *   - Cycle-safe (AC-4): a visited-set guarantees termination on the cyclic
 *     see_also graph (font-fallback <-> font-preload, etc.) without revisiting.
 *   - Depth cap (AC-5): `opts.depth` bounds the closure. The root is depth 0;
 *     a node whose shortest-path depth would exceed the cap is OMITTED (not an
 *     error). Default: DEFAULT_DEPTH.
 *   - Flavor filter (AC-6): a playbook whose `applicable_flavors` excludes the
 *     resolved flavor is excluded from the closure (and not expanded through).
 *   - Edge tags (AC-7): the root carries the sentinel `edges: ['root']`; every
 *     other entry exposes `edges` as the union of edge types that reached it.
 *
 * Pure function (AC-1): no I/O beyond reading playbook files via loadPlaybook;
 * deterministic for a given (root, flavor, opts, playbook dir).
 */

import fs from 'node:fs';
import { loadPlaybook, resolveFlavor } from './attribution.js';
import { extractFrontMatter, parseSeeAlso } from './playbook-see-also-lint.js';

/**
 * Default depth cap. The root is depth 0; a cap of 4 admits up to four hops of
 * see_also expansion. Chosen to comfortably cover the real graph's longest
 * meaningful chain (e.g. request-chain -> resource-preload -> font-preload ->
 * font-fallback -> font-format) while bounding pathological fan-out. Consumers
 * may override via `opts.depth`.
 */
export const DEFAULT_DEPTH = 4;

/**
 * Deterministic edge-type visit order. Edges are expanded in this rank so the
 * diagnostic path (routes_to) leads, then redirect (prefer_instead), additive
 * (complements), and orthogonal last — ties broken alphabetically by target.
 */
const EDGE_RANK = { routes_to: 0, prefer_instead: 1, complements: 2, orthogonal: 3 };

/**
 * Read the typed `see_also` edges of a playbook as `[{ target, edge }]`, in the
 * deterministic visit order. Reuses the 015-01 front-matter + see_also parser.
 * @param {string} issueType
 * @param {object|undefined} loadOpts - passed straight to loadPlaybook ({ dir })
 * @returns {{target: string, edge: string}[]}
 */
function outgoingEdges(issueType, loadOpts) {
  const pb = loadPlaybook(issueType, loadOpts);
  if (!pb || !pb.file) return [];
  // loadPlaybook parses front-matter but does not expose see_also; re-read the
  // raw file text (same path) through the 015-01 parser. loadPlaybook already
  // proved the file is readable, so this normally cannot throw.
  let fm = '';
  try {
    fm = extractFrontMatter(fs.readFileSync(pb.file, 'utf8'));
  } catch {
    return [];
  }
  const entries = parseSeeAlso(fm)
    .filter((e) => e && e.playbook && e.edge)
    .map((e) => ({ target: e.playbook, edge: e.edge }));
  entries.sort((a, b) => {
    const ra = EDGE_RANK[a.edge] ?? 99;
    const rb = EDGE_RANK[b.edge] ?? 99;
    if (ra !== rb) return ra - rb;
    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });
  return entries;
}

/**
 * Is a playbook applicable to the resolved flavor? A playbook with no
 * applicable_flavors (or an unresolvable flavor) is treated as applicable —
 * the flavor filter only excludes when the front-matter explicitly lists
 * flavors and the resolved flavor is not among them.
 */
function isApplicable(frontmatter, flavor) {
  if (!flavor) return true;
  const flavors = (frontmatter && frontmatter.applicableFlavors) || [];
  if (!Array.isArray(flavors) || flavors.length === 0) return true;
  return flavors.includes(flavor);
}

/**
 * Resolve the closure of playbooks reachable from `rootIssueType` over the
 * typed see_also graph, filtered to `flavor`.
 *
 * @param {string} rootIssueType - the root playbook's issue_type.
 * @param {string|null} flavor - a bare flavor (eds|cs|ams|headless) or any
 *   label resolveFlavor accepts (SpaceCat deliveryType, stack-doc name, ...).
 * @param {object} [opts]
 * @param {number} [opts.depth=DEFAULT_DEPTH] - max hops from the root.
 * @param {string} [opts.dir] - override the playbooks directory (else the
 *   attribution default: CWV_PLAYBOOKS_DIR or the vendored dir).
 * @param {string} [opts.source] - a pulled source tree, for flavor resolution
 *   via its importer manifest (channel-aware) — same path attribution uses.
 * @returns {{issueType: string, edges: string[], depth: number}[]}
 */
export function resolveChain(rootIssueType, flavor, opts = {}) {
  const depthCap = Number.isInteger(opts.depth) ? opts.depth : DEFAULT_DEPTH;
  const loadOpts = opts.dir ? { dir: opts.dir } : undefined;
  const resolvedFlavor = resolveFlavor({ flavor, source: opts.source });

  const root = loadPlaybook(rootIssueType, loadOpts);
  if (!root) return [];
  if (!isApplicable(root.frontmatter, resolvedFlavor)) return [];

  // node -> { issueType, edges:Set, depth } ; insertion order = BFS order.
  const found = new Map();
  found.set(rootIssueType, { issueType: rootIssueType, edges: new Set(['root']), depth: 0 });

  // BFS queue of issue types to expand, paired with their (shortest) depth.
  let frontier = [{ issueType: rootIssueType, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const { issueType, depth } of frontier) {
      if (depth >= depthCap) continue; // children would exceed the cap → omit.
      for (const { target, edge } of outgoingEdges(issueType, loadOpts)) {
        const childDepth = depth + 1;
        const existing = found.get(target);
        if (existing) {
          // De-dup (AC-3): seen already — union the edge type onto it.
          existing.edges.add(edge);
          continue;
        }
        // New node: apply the flavor filter (AC-6) before admitting it.
        const pb = loadPlaybook(target, loadOpts);
        if (!pb) continue; // dangling target (lint would flag) — skip safely.
        if (!isApplicable(pb.frontmatter, resolvedFlavor)) continue;
        found.set(target, { issueType: target, edges: new Set([edge]), depth: childDepth });
        next.push({ issueType: target, depth: childDepth });
      }
    }
    frontier = next;
  }

  // Materialize in BFS insertion order, edges as a stable-ordered array.
  return [...found.values()].map((e) => ({
    issueType: e.issueType,
    edges: sortEdges([...e.edges]),
    depth: e.depth,
  }));
}

/** Stable edge-type ordering for output (root sentinel first, else by rank). */
function sortEdges(edges) {
  return [...edges].sort((a, b) => {
    if (a === 'root') return -1;
    if (b === 'root') return 1;
    const ra = EDGE_RANK[a] ?? 99;
    const rb = EDGE_RANK[b] ?? 99;
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
