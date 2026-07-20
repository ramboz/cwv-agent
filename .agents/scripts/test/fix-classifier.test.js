#!/usr/bin/env node

/**
 * Tests for .agents/scripts/fix-classifier.js — the fix-classification gate.
 * Given a patches.json + detected stack, every proposed fix is assigned a
 * Class (1 patch / 2 source-edit / 3 manual-review), a validate route, and a
 * typed rationale — the artifact the operator and the validate step consume.
 *
 * Repo convention: NEVER hit the network. Classification is a pure function.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyFix,
  classifyFixes,
  buildClassification,
  fixesFromPatches,
  buildSummary,
} from '../fix-classifier.js';

// ===========================================================================
// Class 1 — generic mutations → route `patch`.
// ===========================================================================

test('Class 1 / generic / patch: attribute-edit op', () => {
  const e = classifyFix({ op: 'attribute', metric: 'CLS' });
  assert.equal(e.class, 1);
  assert.equal(e.subclass, 'generic');
  assert.equal(e.route, 'patch');
});

test('Class 1 / generic / patch: resource-hint / meta / defer / alt ops', () => {
  for (const op of ['preload', 'preloads', 'fetchpriority', 'meta', 'defer', 'alt']) {
    const e = classifyFix({ op, metric: 'LCP' });
    assert.equal(e.class, 1, `op ${op} → Class 1`);
    assert.equal(e.route, 'patch');
  }
});

test('Class 1 / generic / patch: header, block, rewriteBody, markup, css ops', () => {
  for (const op of ['requestHeaders', 'responseHeaders', 'block', 'rewriteBody', 'markup', 'css-override', 'css']) {
    const e = classifyFix({ op, metric: 'LCP' });
    assert.equal(e.class, 1, `op ${op} → Class 1`);
    assert.equal(e.route, 'patch');
  }
});

// ===========================================================================
// Class 2 — source edits → route `source-edit`.
// ===========================================================================

test('Class 2 / source / source-edit: explicit source-edit op', () => {
  const e = classifyFix({ op: 'source-edit', metric: 'LCP' });
  assert.equal(e.class, 2);
  assert.equal(e.subclass, 'source');
  assert.equal(e.route, 'source-edit');
  assert.match(e.rationale, /diff/i);
});

test('Class 2: a fix carrying structured sourceEdits records', () => {
  const e = classifyFix({
    op: 'whatever-op-name',
    metric: 'CLS',
    sourceEdits: [{ file: 'styles/styles.css', before: 'a', after: 'b' }],
  });
  assert.equal(e.class, 2);
  assert.equal(e.route, 'source-edit');
});

test('Class 2: empty sourceEdits does NOT grant Class 2', () => {
  const e = classifyFix({ op: 'mystery', metric: 'CLS', sourceEdits: [] });
  assert.equal(e.class, 3, 'empty sourceEdits falls through to ambiguous handling');
});

// ===========================================================================
// Class 3 — structural changes → route `manual-review`.
// ===========================================================================

test('Class 3 / structural / manual-review: reorder + structural ops', () => {
  for (const op of ['reorder', 'dom-structural', 'template-structural']) {
    const e = classifyFix({ op, metric: 'LCP' });
    assert.equal(e.class, 3, `op ${op} → Class 3`);
    assert.equal(e.subclass, 'structural');
    assert.equal(e.route, 'manual-review');
    assert.match(e.rationale, /re-measure|manual-review/i);
  }
});

test('a structural op with sourceEdits STILL escalates to manual-review', () => {
  const e = classifyFix({
    op: 'dom-structural',
    metric: 'CLS',
    sourceEdits: [{ file: 'blocks/hero/hero.js', before: 'a', after: 'b' }],
  });
  assert.equal(e.class, 3, 'structural beats source-edit — byte patches cannot prove it');
  assert.equal(e.route, 'manual-review');
});

// ===========================================================================
// Ambiguous / unknown op — never silently Class 1.
// ===========================================================================

test('unknown op escalates to the highest applicable class with a typed reason', () => {
  const e = classifyFix({ op: 'transmogrify', metric: 'INP' });
  assert.equal(e.class, 3);
  assert.equal(e.route, 'manual-review');
  assert.match(e.rationale, /never silently Class 1/);
});

test('missing/empty op escalates too', () => {
  for (const op of [undefined, null, '', '   ']) {
    const e = classifyFix({ op, metric: 'CLS' });
    assert.equal(e.class, 3, `op ${JSON.stringify(op)} must not be silently Class 1`);
  }
});

// ===========================================================================
// classifyFixes orchestrator + summary.
// ===========================================================================

test('classifyFixes returns entries in input order with ids threaded through', async () => {
  const { entries, summary } = await classifyFixes({
    fixes: [
      { id: 'f#0', op: 'preloads', metric: 'LCP' },
      { id: 'f#1', op: 'source-edit', metric: 'CLS' },
      { id: 'f#2', op: 'dom-structural', metric: 'CLS' },
      { id: 'f#3', op: 'nonsense', metric: 'TTFB' },
    ],
  });
  assert.deepEqual(entries.map((e) => e.id), ['f#0', 'f#1', 'f#2', 'f#3']);
  assert.deepEqual(entries.map((e) => e.route), ['patch', 'source-edit', 'manual-review', 'manual-review']);
  assert.equal(summary.total, 4);
  assert.equal(summary.validatesNow, 2, 'patch + source-edit validate now');
  assert.equal(summary.manualReview, 2);
  assert.deepEqual(summary.byRoute, { patch: 1, 'source-edit': 1, 'manual-review': 2 });
  assert.match(summary.line, /4 fix\(es\)/);
});

test('classifyFixes rejects a non-array fixes value', async () => {
  await assert.rejects(() => classifyFixes({ fixes: 'nope' }), TypeError);
});

test('buildSummary on an empty list', () => {
  const s = buildSummary([]);
  assert.equal(s.total, 0);
  assert.equal(s.validatesNow, 0);
  assert.equal(s.manualReview, 0);
});

// ===========================================================================
// fixesFromPatches — patches.json plumbing.
// ===========================================================================

test('fixesFromPatches flattens every patch type with generated ids', () => {
  const fixes = fixesFromPatches({
    id: 'lcp-hero',
    metric: ['LCP'],
    patches: {
      preloads: [{ href: '/hero.avif', as: 'image' }],
      markup: [{ selector: 'img.hero', set: { fetchpriority: 'high' } }],
      block: ['*analytics*'],
      responseHeaders: [{ name: 'cache-control', value: 'max-age=31536000' }],
      rewriteBody: { find: 'a', replace: 'b' },
      css: [{ selector: '.hero', rule: 'min-height:480px' }],
    },
  });
  assert.equal(fixes.length, 6);
  assert.ok(fixes.every((f) => f.id.startsWith('lcp-hero#')));
  assert.ok(fixes.every((f) => f.metric === 'LCP'));
  assert.deepEqual(
    fixes.map((f) => f.op),
    ['preloads', 'markup', 'block', 'responseHeaders', 'rewriteBody', 'css-override'],
  );
});

test('fixesFromPatches with metaById metric overrides', () => {
  const fixes = fixesFromPatches(
    { id: 'x', patches: { preloads: [{ href: '/a' }] } },
    { 'x#0': { metric: 'FCP' } },
  );
  assert.equal(fixes[0].metric, 'FCP');
});

// ===========================================================================
// buildClassification — artifact envelope.
// ===========================================================================

test('buildClassification emits the phase-interface envelope', async () => {
  const { entries } = await classifyFixes({
    fixes: [{ id: 'a#0', op: 'preloads', metric: 'LCP' }],
  });
  const artifact = buildClassification({ entries, stack: 'generic', sourceArtifact: 'patches.json' });
  assert.equal(artifact.schemaVersion, '1.0');
  assert.equal(artifact.kind, 'fix-classification');
  assert.ok(artifact.generatedAt);
  assert.equal(artifact.stack, 'generic');
  assert.equal(artifact.sourceArtifact, 'patches.json');
  assert.equal(artifact.entries.length, 1);
  assert.equal(artifact.summary.total, 1);
});
