import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiagnosisPlaybookContext,
  DEFAULT_MAX_CHARS,
} from '../diagnose-playbook-context.js';

// These tests run against the REAL vendored playbook set (per the DoD): they
// exercise injection for a router metric (layout-shift), a leaf metric
// (lcp-image), and the graceful-degrade path.

// --- AC-1: deterministic + root-first ordering ------------------------------

test('AC-1: deterministic — identical output on repeated calls', () => {
  const a = buildDiagnosisPlaybookContext('layout-shift', 'eds');
  const b = buildDiagnosisPlaybookContext('layout-shift', 'eds');
  assert.equal(a, b, 'same inputs -> byte-identical output');
});

test('AC-1: the root playbook body appears first', () => {
  const ctx = buildDiagnosisPlaybookContext('layout-shift', 'eds');
  assert.ok(ctx.length > 0, 'non-empty context');
  // The very first section header names the root, before any child playbook.
  assert.ok(
    ctx.startsWith('===== playbook: layout-shift'),
    'first section is the root (layout-shift)',
  );
  // The root sentinel edge is surfaced in the header.
  assert.ok(
    ctx.split('\n')[0].includes('reached via: root'),
    'root section header records the root sentinel',
  );
  // The root's body heading precedes the children's bodies.
  const idxRoot = ctx.indexOf('# Layout shift');
  const idxImage = ctx.indexOf('# Image sizing');
  assert.ok(idxRoot >= 0 && idxImage >= 0, 'both bodies present');
  assert.ok(idxRoot < idxImage, 'root body precedes child body');
});

// --- AC-2: router ordering (layout-shift before its routes_to children) -----

test('AC-2: layout-shift body precedes image-sizing and font-fallback bodies', () => {
  const ctx = buildDiagnosisPlaybookContext('layout-shift', 'eds');
  const idxRoot = ctx.indexOf('# Layout shift');
  const idxImage = ctx.indexOf('# Image sizing');
  const idxFont = ctx.indexOf('# Font fallback');
  assert.ok(idxRoot >= 0, 'layout-shift body present');
  assert.ok(idxImage >= 0, 'image-sizing body present (routes_to child)');
  assert.ok(idxFont >= 0, 'font-fallback body present (routes_to child)');
  assert.ok(idxRoot < idxImage, 'layout-shift before image-sizing');
  assert.ok(idxRoot < idxFont, 'layout-shift before font-fallback');
});

test('AC-1: all edge types followed (no edge-type filtering) when budget allows', () => {
  // ADR-0015 §3: the diagnose consumer follows ALL edge types (noise-tolerant),
  // it must not FILTER to routes_to. With ample budget, layout-shift's cs
  // closure surfaces font-preload via a `complements` edge and font-format via
  // an `orthogonal` edge. (NB: under the *default* char bound the edge-rank
  // ordering means these low-rank edges may be budget-omitted first — see the
  // slice deviation log; that is prioritization, not filtering.)
  const ctx = buildDiagnosisPlaybookContext('layout-shift', 'cs', { maxChars: 500000 });
  const headers = ctx
    .split('\n')
    .filter((l) => l.startsWith('===== playbook:'))
    .join('\n');
  assert.match(headers, /reached via:[^)]*\bcomplements\b/, 'a complements-reached body is included');
  assert.match(headers, /reached via:[^)]*\borthogonal\b/, 'an orthogonal-reached body is included');
  assert.ok(headers.includes('playbook: font-preload'), 'font-preload (complements) present with ample budget');
});

// --- AC-3: budget bound + depth cap (widest-fan-out metric) -----------------

test('AC-3: a small maxChars truncates the closure and omits deep bodies', () => {
  const full = buildDiagnosisPlaybookContext('layout-shift', 'eds');
  const rootLen = full.indexOf('\n\n===== playbook:'); // start of the 2nd section.
  assert.ok(rootLen > 0, 'the full closure has more than one section');
  // Budget large enough for the root section only.
  const bounded = buildDiagnosisPlaybookContext('layout-shift', 'eds', { maxChars: rootLen + 5 });
  assert.ok(bounded.length <= rootLen + 5, 'output stays within the bound');
  assert.ok(bounded.startsWith('===== playbook: layout-shift'), 'root still present');
  assert.ok(!bounded.includes('# Image sizing'), 'a deeper body is omitted, not errored');
});

test('AC-3: budget is a no-op omission, never an error, on a tiny bound', () => {
  // A bound below even the first section yields '' rather than throwing.
  const tiny = buildDiagnosisPlaybookContext('layout-shift', 'eds', { maxChars: 1 });
  assert.equal(typeof tiny, 'string');
  assert.equal(tiny, '', 'nothing fits -> empty string');
});

test('AC-3: a shallow depth omits deep playbooks (widest-fan-out metric)', () => {
  const deep = buildDiagnosisPlaybookContext('lcp-image', 'eds', { depth: 4 });
  const shallow = buildDiagnosisPlaybookContext('lcp-image', 'eds', { depth: 0 });
  // depth 0 = root only; deeper cap pulls in more playbook sections.
  const count = (s) => (s.match(/===== playbook:/g) || []).length;
  assert.equal(count(shallow), 1, 'depth 0 = root section only');
  assert.ok(count(deep) > count(shallow), 'a deeper cap includes more playbooks');
  assert.ok(shallow.startsWith('===== playbook: lcp-image'), 'root is lcp-image');
});

test('AC-3: DEFAULT_MAX_CHARS is a documented, sane default', () => {
  assert.equal(typeof DEFAULT_MAX_CHARS, 'number');
  assert.ok(DEFAULT_MAX_CHARS > 1000, 'default budget admits a real closure');
});

// --- AC-4: graceful degrade -------------------------------------------------

test('AC-4: an unknown issueType returns "" and does not throw', () => {
  let out;
  assert.doesNotThrow(() => { out = buildDiagnosisPlaybookContext('does-not-exist', 'eds'); });
  assert.equal(out, '');
});
