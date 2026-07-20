import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveChain, DEFAULT_DEPTH } from '../playbook-chain.js';

// These tests run against the REAL vendored playbook set (per the DoD), except
// for the two isolated cases (controlled cycle / depth cap) that need a
// synthetic fixture to be exercised deterministically.

const entryFor = (chain, issueType) => chain.find((e) => e.issueType === issueType);
const edgeSet = (entry) => new Set(entry.edges);

// --- AC-1 signature + AC-2 ordering ----------------------------------------

test('AC-1/AC-2: root playbook is first and its routes_to children appear', () => {
  const chain = resolveChain('layout-shift', 'eds');
  assert.ok(Array.isArray(chain), 'returns an array');
  assert.equal(chain[0].issueType, 'layout-shift', 'root is first');
  assert.deepEqual(chain[0].edges, ['root'], 'root carries the root sentinel');
  assert.equal(chain[0].depth, 0, 'root depth is 0');
  // layout-shift routes_to image-sizing + font-fallback (real graph).
  assert.ok(entryFor(chain, 'image-sizing'), 'image-sizing reachable');
  assert.ok(entryFor(chain, 'font-fallback'), 'font-fallback reachable');
});

test('AC-2: ordering is stable across runs', () => {
  const a = resolveChain('lcp-image', 'eds').map((e) => e.issueType);
  const b = resolveChain('lcp-image', 'eds').map((e) => e.issueType);
  assert.deepEqual(a, b, 'identical ordering on repeated runs');
});

// --- AC-7 edge tags preserved + redirect edge -------------------------------

test('AC-7: the font-preload -> font-fallback edge is typed prefer_instead', () => {
  const chain = resolveChain('font-preload', 'eds');
  const ff = entryFor(chain, 'font-fallback');
  assert.ok(ff, 'font-fallback reachable from font-preload');
  assert.ok(edgeSet(ff).has('prefer_instead'), 'edge tagged prefer_instead');
});

test('AC-7: every non-root entry exposes at least one edge type', () => {
  const chain = resolveChain('layout-shift', 'eds');
  for (const entry of chain.slice(1)) {
    assert.ok(Array.isArray(entry.edges) && entry.edges.length > 0,
      `${entry.issueType} exposes edge tags`);
  }
});

// --- AC-3 de-dup + union of edge types --------------------------------------

test('AC-3: a node reachable two ways appears once with the union of edges', () => {
  // layout-shift -> font-fallback (routes_to)
  // layout-shift -> font-preload (complements) -> font-fallback (prefer_instead)
  const chain = resolveChain('layout-shift', 'eds');
  const matches = chain.filter((e) => e.issueType === 'font-fallback');
  assert.equal(matches.length, 1, 'font-fallback appears exactly once');
  const edges = edgeSet(matches[0]);
  assert.ok(edges.has('routes_to'), 'retains routes_to');
  assert.ok(edges.has('prefer_instead'), 'retains prefer_instead (union)');
});

// --- AC-4 cycle-safe --------------------------------------------------------

test('AC-4: resolving a root inside a known cycle terminates, each node once', () => {
  // font-fallback <-> font-preload, font-fallback <-> font-format are cycles.
  const chain = resolveChain('font-fallback', 'eds');
  const seen = chain.map((e) => e.issueType);
  const uniq = new Set(seen);
  assert.equal(seen.length, uniq.size, 'no node revisited');
  assert.equal(chain[0].issueType, 'font-fallback', 'root present, first');
  assert.ok(uniq.has('font-preload') && uniq.has('font-format'), 'cycle members present');
});

// --- AC-6 flavor filter -----------------------------------------------------

test('AC-6: a reachable playbook not applicable to the flavor is excluded', () => {
  // lcp-image -> layout-shift (complements). layout-shift applicable_flavors is
  // [eds, cs] on the real graph, so on 'ams' it must be filtered out.
  const ams = resolveChain('lcp-image', 'ams');
  assert.ok(!entryFor(ams, 'layout-shift'), 'layout-shift excluded on ams');
  // On eds it IS reachable (sanity: the filter is what removed it, not the graph).
  const eds = resolveChain('lcp-image', 'eds');
  assert.ok(entryFor(eds, 'layout-shift'), 'layout-shift present on eds');
});

// --- AC-5 depth cap (synthetic fixture for an isolated, deterministic chain) -

test('AC-5: opts.depth bounds the closure; deeper cap includes more', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbchain-'));
  const write = (name, flavors, seeAlso) => {
    const sa = seeAlso.length
      ? `see_also:\n${seeAlso.map((s) => `  - playbook: ${s.playbook}\n    edge: ${s.edge}\n    reason: t`).join('\n')}\n`
      : '';
    fs.writeFileSync(path.join(dir, `${name}.md`),
      `---\nissue_type: ${name}\napplicable_flavors: [${flavors.join(', ')}]\nrisk_tier: low\n${sa}---\nbody\n`);
  };
  // linear chain a -> b -> c -> d
  write('a', ['eds'], [{ playbook: 'b', edge: 'routes_to' }]);
  write('b', ['eds'], [{ playbook: 'c', edge: 'routes_to' }]);
  write('c', ['eds'], [{ playbook: 'd', edge: 'routes_to' }]);
  write('d', ['eds'], []);

  const shallow = resolveChain('a', 'eds', { dir, depth: 1 }).map((e) => e.issueType);
  assert.deepEqual(shallow, ['a', 'b'], 'depth 1 = root + one hop');

  const deep = resolveChain('a', 'eds', { dir, depth: 3 }).map((e) => e.issueType);
  assert.deepEqual(deep, ['a', 'b', 'c', 'd'], 'depth 3 = full chain');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-5: DEFAULT_DEPTH is a documented, sane default', () => {
  assert.equal(typeof DEFAULT_DEPTH, 'number');
  assert.ok(DEFAULT_DEPTH >= 1, 'default cap admits at least one hop');
});

test('AC-1: missing root playbook resolves to an empty closure (no throw)', () => {
  const chain = resolveChain('does-not-exist', 'eds');
  assert.deepEqual(chain, []);
});
