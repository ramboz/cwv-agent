#!/usr/bin/env node

/**
 * Tests for the fix→publish contract (spec slice 003-04).
 *
 * `fix-findings.json` is the Finding-native hand-off that `cwv-publish`
 * (003-02) consumes. This suite proves two things:
 *
 *  1. The schema persists `source-mapper`'s structured source-edit records
 *     (`sourceEdits: [{ file, before, after, line? }]`) — the raw material the
 *     publish step formats into a unified diff. (`patches` is CDP/DOM runtime
 *     mutations, NOT a diff, so it cannot serve this role.)
 *
 *  2. A finished, validated `fix-findings.json` yields a handoff-ready
 *     unified diff derivable purely from `sourceEdits`.
 *
 * The report/handoff assembly is the cwv-report skill's job — NOT exercised
 * here. We only assert derivability.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validateFinding } from '../finding-schema.js';
import { editsToUnifiedDiff } from '../source-edits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'fix-findings.example.json');

/** Load the example envelope and return its single validated finding. */
function loadExampleFinding() {
  const env = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const findings = Array.isArray(env.findings) ? env.findings : [env];
  return { env, finding: findings[0] };
}

// ---------------------------------------------------------------------------
// AC#3a — the example fixture is schema-valid.
// ---------------------------------------------------------------------------

test('fix-findings.example.json passes validateFinding', () => {
  const { finding } = loadExampleFinding();
  const res = validateFinding(finding);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('the example finding is a terminal validated fix with the publish-handoff fields', () => {
  const { finding } = loadExampleFinding();
  assert.equal(finding.status, 'validated', 'fixture must be a validated finding');
  // recommendation -> suggestion title; cause -> description; both required for patch publish.
  assert.ok(typeof finding.recommendation === 'string' && finding.recommendation.length > 0);
  assert.ok(typeof finding.cause === 'string' && finding.cause.length > 0);
  // measurement-delta evidence carries baseline/treatment for kpiDeltas keying.
  const md = (finding.evidence || []).find((e) => e.kind === 'measurement-delta');
  assert.ok(md, 'fixture must carry a measurement-delta evidence entry');
  assert.equal(typeof md.data.baseline, 'number');
  assert.equal(typeof md.data.treatment, 'number');
});

// ---------------------------------------------------------------------------
// `sourceEdits` schema validation (the crux of this slice).
// ---------------------------------------------------------------------------

/** Minimal schema-valid validated finding; sourceEdits supplied by caller. */
function baseValidatedFinding(sourceEdits) {
  const f = {
    schemaVersion: '1.0',
    id: 'validate-cls-1',
    timestamp: '2026-06-11T00:00:00.000Z',
    url: 'https://example.com/',
    skill: 'cwv-validate',
    source: 'perf_observer',
    metric: ['CLS'],
    type: 'opportunity',
    severity: 'high',
    rootCause: true,
    cause: 'late banner reveal shifts main content',
    evidence: [
      { kind: 'measurement-delta', data: { metric: 'CLS', baseline: 0.144, treatment: 0.025, deltaScore: -0.119, runs: 15 } },
    ],
    recommendation: 'make the header position:sticky so it reserves its own space',
    confidence: 0.85,
    impactReduction: { metric: 'CLS', score: 0.119 },
    status: 'validated',
  };
  if (sourceEdits !== undefined) f.sourceEdits = sourceEdits;
  return f;
}

test('sourceEdits is OPTIONAL — a validated finding without it still validates', () => {
  const res = validateFinding(baseValidatedFinding(undefined));
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
  assert.ok(
    res.warnings.some((w) => /validated finding has no sourceEdits/.test(w)),
    `warnings: ${JSON.stringify(res.warnings)}`,
  );
});

test('valid sourceEdits (the source-mapper subset) passes', () => {
  const f = baseValidatedFinding([
    { file: 'styles/header.css', before: 'position: fixed;', after: 'position: sticky;', line: 42 },
    { file: 'blocks/header/header.js', before: 'el.show(300);', after: 'el.show();' },
  ]);
  const res = validateFinding(f);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('sourceAvailability records source-s3 handoff status', () => {
  const f = baseValidatedFinding([
    { file: 'styles/header.css', before: 'position: fixed;', after: 'position: sticky;', line: 42 },
  ]);
  f.sourceAvailability = {
    status: 'fetched',
    siteId: '90abcb83-bbfb-4bbd-8313-a0adc2986ce2',
    deliveryType: 'aem_cs',
    manifestPath: 'progress/example/source-manifest.json',
    sourceRoot: 'progress/example/source',
    s3Key: 'code/90abcb83-bbfb-4bbd-8313-a0adc2986ce2/standard/owner/repo/ref/repository.zip',
    checkedAt: '2026-06-20T12:34:56.000Z',
  };
  const res = validateFinding(f);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('sourceAvailability rejects unknown status', () => {
  const f = baseValidatedFinding(undefined);
  f.sourceAvailability = { status: 'maybe_later' };
  const res = validateFinding(f);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceAvailability\.status/.test(e)));
});

test('validated finding with fetched source but no sourceEdits warns to map source', () => {
  const f = baseValidatedFinding(undefined);
  f.sourceAvailability = { status: 'fetched' };
  const res = validateFinding(f);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
  assert.ok(res.warnings.some((w) => /fetched.*no sourceEdits/.test(w)));
});

test('sourceEdits must be an array', () => {
  const res = validateFinding(baseValidatedFinding({ file: 'a.css', before: 'x', after: 'y' }));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits must be an array/.test(e)));
});

test('sourceEdits entry must be an object', () => {
  const res = validateFinding(baseValidatedFinding(['not-an-object']));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits\[0\] must be an object/.test(e)));
});

test('sourceEdits entry requires a non-empty file', () => {
  const res = validateFinding(baseValidatedFinding([{ file: '', before: 'x', after: 'y' }]));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits\[0\]\.file must be a non-empty string/.test(e)));
});

test('sourceEdits entry requires before/after strings', () => {
  const res = validateFinding(baseValidatedFinding([{ file: 'a.css', before: 1, after: 'y' }]));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits\[0\]\.before must be a string/.test(e)));
});

test('sourceEdits entry line, when present, must be a number', () => {
  const res = validateFinding(baseValidatedFinding([{ file: 'a.css', before: 'x', after: 'y', line: 'top' }]));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits\[0\]\.line must be a number/.test(e)));
});

test('sourceEdits entry line is optional (the EDS decorator case has line: null)', () => {
  const res = validateFinding(baseValidatedFinding([{ file: 'blocks/x/x.js', before: 'a', after: 'b', line: null }]));
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

// ---------------------------------------------------------------------------
// editsToUnifiedDiff — the tiny pure formatter that proves diff derivability.
// (003-02 consumes this against real source; here it only proves AC#3.)
// ---------------------------------------------------------------------------

test('editsToUnifiedDiff turns sourceEdits into a clean unified diff', () => {
  const diff = editsToUnifiedDiff([
    { file: 'styles/header.css', before: 'position: fixed;', after: 'position: sticky;', line: 42 },
  ]);
  // unified-diff anatomy: ---/+++ file headers, an @@ hunk, - before, + after.
  assert.match(diff, /^--- a\/styles\/header\.css$/m);
  assert.match(diff, /^\+\+\+ b\/styles\/header\.css$/m);
  assert.match(diff, /^@@ /m);
  assert.match(diff, /^-position: fixed;$/m);
  assert.match(diff, /^\+position: sticky;$/m);
  // no prose leaks into the diff
  assert.ok(!/Rationale|Auto-applicable/.test(diff));
});

test('the round-trip diff is derivable purely from sourceEdits (no patches needed)', () => {
  const { finding } = loadExampleFinding();
  // sourceEdits is the basis for the publish diff — assert it is present & shaped.
  assert.ok(Array.isArray(finding.sourceEdits) && finding.sourceEdits.length >= 1);
  for (const e of finding.sourceEdits) {
    assert.ok(typeof e.file === 'string' && e.file.length > 0);
    assert.equal(typeof e.before, 'string');
    assert.equal(typeof e.after, 'string');
  }
  const diff = editsToUnifiedDiff(finding.sourceEdits);
  assert.ok(diff.length > 0 && diff.includes('@@'));
});
